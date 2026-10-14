// A syntax error in a cell file must not end the dev session.
//
// The supervisor used to pass the child's exit code straight through: the
// relaunched child failed at module load (exit 1), the supervisor exited 1,
// and the developer — mid-edit — had no dev server and nothing saying why
// beyond the SyntaxError. Typos are the normal state of a file being edited.
// Now a child that dies right after a relaunch is a FAILED RESTART: the
// supervisor stays up, says so, and relaunches on the next save.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { FAILED_RESTART_WINDOW_MS } from "../src/server/dev-restart.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv, freePort, kill } from "./e2e-app-harness.ts";
import { spec } from "./module-spec-helper.ts";

const appSource = (port: number) =>
  `import { aio } from "aio";
import { probe } from "./cell.ts";
await aio.run({
  appId: "dev-restart-typo-e2e",
  cells: [probe],
  client: "server-only",
  persist: false,
  port: ${port},
  routes: { "/mark": () => new Response(probe.mark) },
});
`;
const cellSource = (mark: string) =>
  `import { cell } from "aio";
export const probe = cell("probe", {
  state: { mark: "${mark}" },
  methods: { set(s: { mark: string }, m: string) { s.mark = m; } },
});
`;

async function servedMark(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/mark`);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}
async function waitFor<T>(
  fn: () => Promise<T | null>,
  ms: number,
): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}
const alive = (pid: number) => {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    "dev-restart e2e: a typo in the cell file keeps the dev session up; fixing it relaunches",
  async fn() {
    assert(FAILED_RESTART_WINDOW_MS >= 5_000, "window must cover a slow boot");
    const dir = await Deno.makeTempDir({ prefix: "aio-dev-restart-typo-" });
    const port = freePort();
    const url = `http://127.0.0.1:${port}`;
    const repo = fromFileUrl(new URL("../", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${spec(repo)}mod.ts`,
          "aio/": `${spec(repo)}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "app.ts"), appSource(port));
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));

    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: childEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let text = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) text += new TextDecoder().decode(c);
    };
    const drained = Promise.allSettled([
      drain(child.stdout),
      drain(child.stderr),
    ]);
    try {
      assertEquals(await waitFor(() => servedMark(url), 30_000), "v1", text);
      // A good edit first, so the process is in supervisor mode.
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v2"));
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === "v2" ? "v2" : null,
          30_000,
        ),
        "v2",
        `first restart never served v2:\n${text}`,
      );
      // The typo.
      await Deno.writeTextFile(
        join(dir, "cell.ts"),
        cellSource("v3") + "\nthis is not valid typescript {{{\n",
      );
      const gone = await waitFor(
        async () => (await servedMark(url)) === null ? "down" : null,
        20_000,
      );
      assertEquals(gone, "down", "the broken cell must stop the old child");
      // Wait for the SAYING, not a fixed sleep: the relaunch that fails on the
      // typo took ~2.3s on a loaded suite, and a 1.5s sleep looked before it.
      const said = await waitFor(
        () => Promise.resolve(/stays up/.test(text) ? "said" : null),
        30_000,
      );
      assert(
        alive(child.pid),
        `the supervisor exited on a syntax error — the dev session is gone:\n${text}`,
      );
      assertEquals(
        said,
        "said",
        `the supervisor must SAY it is waiting for a fix:\n${text}`,
      );
      // Fix it: the app must come back by itself.
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v4"));
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === "v4" ? "v4" : null,
          30_000,
        ),
        "v4",
        `the fixed cell never came back:\n${text}`,
      );
    } finally {
      await kill(child);
      await drained; // the pipes end with the process; wait for that end
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

/** A cell file that does not load — it says it was loaded (`loaded.mark`),
 *  and fails only once the FIXED file is on disk: the save lands while this
 *  child is still starting, by construction (bounded, so a missing fix is
 *  still a failed start). */
const failsOnceFixed = `
const me = new URL(import.meta.url).pathname;
Deno.writeTextFileSync(new URL("./loaded.mark", import.meta.url), "x");
for (let i = 0; i < 400; i++) {
  // (the fixed file is the one that does not name the mark)
  if (!Deno.readTextFileSync(me).includes("loaded.mark")) break;
  await new Promise((r) => setTimeout(r, 50));
}
throw new Error("the file this start loaded does not load");
`;

Deno.test({
  name:
    "dev-restart e2e: a fix saved WHILE the failing start is still booting relaunches the app",
  async fn() {
    const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
    const dir = await tempDir("dev-restart-midboot-");
    const port = freePort();
    const url = `http://127.0.0.1:${port}`;
    const repo = fromFileUrl(new URL("../", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${spec(repo)}mod.ts`,
          "aio/": `${spec(repo)}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "app.ts"), appSource(port));
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: childEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let text = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) text += new TextDecoder().decode(c);
    };
    const drained = Promise.allSettled([
      drain(child.stdout),
      drain(child.stderr),
    ]);
    try {
      assertEquals(await waitFor(() => servedMark(url), 30_000), "v1", text);
      await Deno.writeTextFile(
        join(dir, "cell.ts"),
        cellSource("broken") + failsOnceFixed,
      );
      // The relaunched child HAS the broken file, and cannot exit before
      // this save, which it is waiting for.
      assertEquals(
        await waitFor(
          () =>
            Deno.stat(join(dir, "loaded.mark")).then(
              () => "loaded",
              () => null,
            ),
          30_000,
        ),
        "loaded",
        `the relaunched child never loaded the broken cell:\n${text}`,
      );
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("fixed"));
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === "fixed" ? "fixed" : null,
          45_000,
        ),
        "fixed",
        `the fix saved while the failing start was booting was never seen:\n${text}`,
      );
    } finally {
      await kill(child);
      await drained;
      await dropTempDir(dir);
    }
  },
});

/** A dev session on a fresh app dir (cell at "v1", served), handed to `fn`
 *  with everything it printed so far; killed and removed after. */
async function devSession(
  prefix: string,
  fn: (
    s: { dir: string; url: string; pid: number; text: () => string },
  ) => Promise<void>,
): Promise<void> {
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const dir = await tempDir(prefix);
  const port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const repo = fromFileUrl(new URL("../", import.meta.url));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "aio": `${spec(repo)}mod.ts`,
        "aio/": `${spec(repo)}src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "app.ts"), appSource(port));
  await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(dir, "app.ts")],
    cwd: dir,
    env: childEnv(),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let text = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) text += new TextDecoder().decode(c);
  };
  const drained = Promise.allSettled([
    drain(child.stdout),
    drain(child.stderr),
  ]);
  try {
    assertEquals(await waitFor(() => servedMark(url), 30_000), "v1", text);
    await fn({ dir, url, pid: child.pid, text: () => text });
  } finally {
    await kill(child);
    await drained;
    await dropTempDir(dir);
  }
}

// What an ordinary app does: its start writes a generated source file (a
// route manifest, codegen) — the same file, every start. When such a start
// then fails, that file is newer than the spawn each time; taken for a fix it
// relaunched the failing app again and again. It is relaunched ONCE (nothing
// says yet who wrote the file), and the second failed start, which finds the
// same file and no other, waits for a save.
Deno.test({
  name:
    "dev-restart e2e: a failing start that writes its own generated source file is not relaunched on it again — it waits, and a real fix relaunches",
  async fn() {
    await devSession("dev-restart-codegen-", async ({ dir, url, text }) => {
      // Each start counts itself (not a source file), writes the manifest,
      // and does not load.
      await Deno.writeTextFile(
        join(dir, "cell.ts"),
        cellSource("broken") +
          `\nDeno.writeTextFileSync(new URL("./starts.log", import.meta.url), "b", { append: true });\n` +
          `Deno.writeTextFileSync(new URL("./routes.gen.ts", import.meta.url), "export const routes = [];\\n");\n` +
          `throw new Error("does not load");\n`,
      );
      const starts = () =>
        Deno.readTextFile(join(dir, "starts.log")).then(
          (t) => t.length,
          () => 0,
        );
      const reached = (n: number, ms: number) =>
        waitFor(async () => (await starts()) >= n ? n : null, ms);
      assertEquals(await reached(2, 45_000), 2, text());
      assertEquals(
        await reached(3, 4_000),
        null,
        `a third start was made on the app's own generated file:\n${text()}`,
      );
      assert(!/failed starts in a row/.test(text()), text());
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("fixed"));
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === "fixed" ? "fixed" : null,
          45_000,
        ),
        "fixed",
        text(),
      );
      assertEquals(await starts(), 2);
    });
  },
});

Deno.test({
  name:
    "dev-restart e2e: a start that writes a NEW source file every time and fails is throttled, not relaunched without end",
  async fn() {
    await devSession("dev-restart-selfwrite-", async ({ dir, pid, text }) => {
      await Deno.writeTextFile(
        join(dir, "cell.ts"),
        cellSource("broken") +
          `\nDeno.writeTextFileSync(new URL("./gen-" + Date.now() + ".ts", import.meta.url), "export {};");\n` +
          `throw new Error("does not load");\n`,
      );
      assertEquals(
        await waitFor(
          () =>
            Promise.resolve(
              /failed starts in a row/.test(text()) ? "throttled" : null,
            ),
          90_000,
        ),
        "throttled",
        `the supervisor never said it throttles the failing starts:\n${text()}`,
      );
      assert(alive(pid), `the dev session is gone:\n${text()}`);
    });
  },
});

Deno.test("savedFresh: the same file saved during two failing starts — other bytes are a fix, the same bytes are not", async () => {
  const { savedFresh, savedStamps } = await import(
    "../src/server/dev-restart.ts"
  );
  const dir = await tempDir("aio-dev-restart-fresh-");
  try {
    const app = join(dir, "app.ts");
    await Deno.writeTextFile(app, "broken 1");
    const first = savedStamps([app]);
    assertEquals(savedFresh(new Map(), first), true, "a first save is fresh");
    await Deno.writeTextFile(app, "broken 1");
    assertEquals(
      savedFresh(first, savedStamps([app])),
      false,
      "the start's own rewrite of the same bytes is waited for",
    );
    await Deno.writeTextFile(app, "fixed  2"); // the same length, other bytes
    assertEquals(
      savedFresh(first, savedStamps([app])),
      true,
      "a fix in the file the last failed start already named relaunches",
    );
    await Deno.remove(app);
    const gone = savedStamps([app]);
    assertEquals(gone.get(app), "", "a file removed since the listing");
    assertEquals(savedFresh(gone, savedStamps([app])), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("eventIsNews: the failed start's own write heard late is not a save; other bytes, another file and a removed one are — by the file, not its spelling", async () => {
  const { eventIsNews, savedStamps } = await import(
    "../src/server/dev-restart.ts"
  );
  const dir = await tempDir("aio-dev-restart-news-");
  try {
    const gen = join(dir, "routes.gen.ts");
    const cellFile = join(dir, "cell.ts");
    await Deno.writeTextFile(gen, "export const routes = [];\n");
    await Deno.writeTextFile(cellFile, "broken");
    const last = savedStamps([gen]); // what the look after the failure held
    assertEquals(eventIsNews(last, [gen]), false, "the same bytes, heard late");
    // The same file under another spelling (macOS: /tmp is /private/tmp).
    const link = join(dir, "link");
    await Deno.symlink(dir, link);
    assertEquals(eventIsNews(last, [join(link, "routes.gen.ts")]), false);
    assertEquals(eventIsNews(last, [cellFile]), true, "a file it did not hold");
    assertEquals(eventIsNews(last, [gen, cellFile]), true);
    await Deno.writeTextFile(gen, "export const routes = [1];\n");
    assertEquals(
      eventIsNews(last, [gen]),
      true,
      "other bytes in the same file",
    );
    await Deno.remove(gen);
    assertEquals(eventIsNews(last, [gen]), true, "removed");
    await Deno.remove(link);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("sourcesChangedSince: the source files saved at or after the mark; an older one, a non-source file, a dot-dir and node_modules are not", async () => {
  const { sourcesChangedSince } = await import("../src/server/dev-restart.ts");
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const dir = await tempDir("dev-restart-since-");
  try {
    const mark = Math.floor(Date.now() / 1000) * 1000 + 500;
    const put = async (rel: string, ms: number) => {
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, "x");
      await Deno.utime(path, new Date(ms), new Date(ms));
      return path;
    };
    await put("cell.ts", mark - 60_000);
    await put("notes.txt", mark + 100);
    await put(".aio/state.json", mark + 100);
    await put("node_modules/pkg/index.js", mark + 100);
    // A millisecond stamp just before the mark is before it.
    await put("early.ts", mark - 1);
    assertEquals(sourcesChangedSince(dir, mark), []);
    const app = await put("src/ui/App.tsx", mark + 100);
    assertEquals(sourcesChangedSince(dir, mark), [app]);
    // A stamp whose milliseconds happen to be 000, on a filesystem that keeps
    // milliseconds (the files above show it does): a save from BEFORE the
    // mark. Read as a coarse stamp it restarted a dev app once for nothing,
    // one start in a thousand.
    await put("round.ts", mark - 500);
    assertEquals(sourcesChangedSince(dir, mark), [app]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("sourcesChangedSince: where every stamp is a whole second, a save in the mark's own second counts; the second before does not", async () => {
  const { sourcesChangedSince, wholeSeconds } = await import(
    "../src/server/dev-restart.ts"
  );
  // The decider, pure: one stamp with milliseconds is a filesystem that
  // keeps them; no stamp at all decides nothing.
  assertEquals(wholeSeconds([1000, 5000]), true);
  assertEquals(wholeSeconds([1000, 5001]), false);
  assertEquals(wholeSeconds([]), false);
  // A filesystem that keeps whole seconds stamps a save made in the mark's
  // own second — after it — with the second's start. This machine's keeps
  // milliseconds (and a birth time nothing can set), so the tree is given to
  // the decider as such a filesystem would show it.
  const mark = 1_700_000_000_500;
  const second = mark - 500;
  assert(wholeSeconds([second, second - 1000]));
  const coarseMark = wholeSeconds([second]) ? mark - mark % 1000 : mark;
  assert(second >= coarseMark, "a save in the mark's own second counts");
  assert(second - 1000 < coarseMark, "the second before it does not");
  // …and on THIS filesystem a real tree is never read as one.
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const dir = await tempDir("dev-restart-coarse-");
  try {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const path = join(dir, "only.ts");
    await Deno.writeTextFile(path, "x");
    await Deno.utime(path, new Date(now), new Date(now));
    const born = (await Deno.stat(path)).birthtime?.getTime();
    // Skipped only where the file was born on a whole second (1 in 1000) or
    // the platform reports no birth time.
    if (born !== undefined && born % 1000 !== 0) {
      assertEquals(sourcesChangedSince(dir, now + 400), []);
    }
  } finally {
    await dropTempDir(dir);
  }
});

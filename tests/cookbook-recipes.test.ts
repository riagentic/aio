// The cookbook's twenty recipes, RUN — not read.
//
// `docs/basics/cookbook.md` is a page of copy-paste snippets, and a snippet
// that does not work is worse than a missing page: the reader spends an
// afternoon believing the framework is broken. Two gates hold it, and they
// answer different questions, so neither is a second decider for the other:
//
//   • `tests/docs-snippets-check.test.ts` — the repo's ONE decider for "does a
//     doc snippet type-check". It already walks docs/, so the cookbook is in
//     its batch for free. This file does not re-check types (the child process
//     below runs `--no-check`); it ASSERTS that every cookbook block is in a
//     shape that gate picks up, so the coverage cannot quietly lapse.
//   • this file — "does the snippet DO what the recipe says". Every block is
//     written to disk as the file its first line names, laid out as one small
//     app, and driven: a cell through `testCell`/`bootCells`, a component
//     through `testUI`, a route through a real `testServer` over HTTP, and the
//     privacy recipe through `testMultiClient` over a real WebSocket, because
//     `visible` filtering is a property of the BROADCAST and an in-process
//     harness reads the server's own store.
//
// Three support files (`weather-api.ts`, `media.ts`, `RiskyPanel.tsx`) are
// written by this test rather than by the doc: they stand for the reader's own
// I/O wrapper, device wrapper and failing panel, and the recipes say so in
// prose. Everything else on the page is the reader's exact copy.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url);
const DOC = "docs/basics/cookbook.md";

/** How many recipes the page promises. The title says twenty; a page that
 *  quietly became nineteen is the page lying about itself. */
const RECIPE_COUNT = 20;

/** Recipes whose LAST MILE cannot be reached in-process (a real OS device, a
 *  real worker thread). They are still driven here as far as a test reaches;
 *  the doc must say so in the section itself, which the gate below checks. */
const ILLUSTRATIVE_LAST_MILE = new Set([18, 20]);

// ── The doc, parsed ──────────────────────────────────────────────────

type Recipe = { n: number; title: string; body: string; files: DocFile[] };
type DocFile = { path: string; lang: "ts" | "tsx"; code: string; line: number };

const FENCE_RE = /```(ts|tsx)\b([^\n]*)\n([\s\S]*?)```/g;
const DECL_PATH_RE = /^\/\/\s*([\w-][\w./-]*\.tsx?)\s*$/;

/** The fragment markers `docs-snippets-check.test.ts` uses to skip a block. A
 *  cookbook block must contain NONE of them — every recipe is whole. */
function looksElided(code: string): boolean {
  return code.includes("…") || /^\s*\.\.\.\s*$/m.test(code) ||
    /\/\/\s*\.\.\./.test(code) || /\.\.\.\s*[}\])]/.test(code) ||
    code.includes("@ts-ignore-doc") ||
    code.trimStart().startsWith("// snippet: fragment");
}

function parseCookbook(text: string): Recipe[] {
  const lines = text.split("\n");
  const starts: { n: number; title: string; at: number }[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    const m = /^## (\d+)\. (.+)$/.exec(lines[i]!);
    if (m) starts.push({ n: Number(m[1]), title: m[2]!, at: i });
  }
  return starts.map((s, i) => {
    const end = starts[i + 1]?.at ?? lines.length;
    const body = lines.slice(s.at, end).join("\n");
    const files: DocFile[] = [];
    for (const m of body.matchAll(FENCE_RE)) {
      const [, lang, info, code] = m;
      assert(
        !info!.includes("no-check"),
        `${DOC} recipe ${s.n}: a block opts out of the type-check gate — ` +
          `a cookbook has no untested snippets`,
      );
      assert(
        !looksElided(code!),
        `${DOC} recipe ${s.n}: a block carries an ellipsis/fragment marker, ` +
          `so docs-snippets-check.test.ts skips it. Recipes are whole files.`,
      );
      assert(
        /(?:import|export)[^\n]*from\s*["'](?:aio|\.)/.test(code!),
        `${DOC} recipe ${s.n}: a block imports nothing from aio or a ` +
          `relative path, so the type-check gate does not see it`,
      );
      const first = code!.trimStart().split("\n", 1)[0]!.trim();
      const path = DECL_PATH_RE.exec(first)?.[1];
      assert(
        path,
        `${DOC} recipe ${s.n}: a block's first line must name its file, ` +
          `e.g. \`// src/cell/tasks.ts\` — that name is what this test ` +
          `writes it to disk as`,
      );
      files.push({
        path,
        lang: lang as "ts" | "tsx",
        code: code!,
        line: body.slice(0, m.index).split("\n").length + s.at + 1,
      });
    }
    return { n: s.n, title: s.title, body, files };
  });
}

// ── The environment the recipes assume ───────────────────────────────

/** Files a recipe names as "your own" — the doc says what each must provide;
 *  these are the stand-ins the drivers run against. */
const SUPPORT: Record<string, string> = {
  "src/cell/weather-api.ts": `
export let calls = 0;
export function fetchWeather(city: string): Promise<number> {
  calls++;
  return Promise.resolve(city.length);
}
`,
  "src/media.ts": `
export type Cam = { id: string };
export let opens = 0;
export let closes = 0;
export function openCamera(id: string, _signal: AbortSignal): Promise<Cam> {
  opens++;
  return Promise.resolve({ id });
}
export function closeCamera(_cam: Cam): void {
  closes++;
}
`,
  "src/RiskyPanel.tsx": `
export function RiskyPanel(): never {
  throw new Error("no data");
}
`,
};

// ── One driver per recipe ────────────────────────────────────────────
//
// Each entry is a whole test module, written beside the recipe files and run
// by one `deno test` child. Keep them short: the recipe is the subject, the
// driver is the assertion.

const DRIVERS: Record<number, string> = {
  1: `
import { assertEquals } from "@std/assert";
import { testCell, testUI } from "aio/testing";
import { tasks } from "../src/cell/tasks.ts";
import TaskList from "../src/TaskList.tsx";

testUI(TaskList, "recipe 1: a typed task reaches the cell", async (ui) => {
  ui.TaskInput.type("buy milk");
  ui.AddButton.click();
  await ui.expectCell(tasks, (s) => s.items.length === 1);
  assertEquals(ui.remaining.text, "1 left");
});

testCell(tasks, "recipe 1: toggle and remove", async (t) => {
  await t.send.add("a");
  await t.send.add("b");
  await t.send.toggle(1);
  t.expect.state((s) => s.items[0]!.done === true, "toggle flips done");
  await t.send.remove(1);
  t.expect.state((s) => s.items.length === 1 && s.items[0]!.id === 2);
  await t.expect.rejects!(() => t.send.add("   "), /needs text/);
});
`,
  2: `
import { testCell } from "aio/testing";
import { view } from "../src/cell/view.ts";

testCell(view, "recipe 2: client-scoped state still dispatches", async (t) => {
  await t.send.setFilter("done");
  await t.send.setQuery("milk");
  t.expect.state((s) => s.filter === "done" && s.query === "milk");
});
`,
  3: `
import { assert, assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import { signup } from "../src/cell/signup.ts";
import SignupForm from "../src/SignupForm.tsx";

testUI(SignupForm, "recipe 3: invalid submit is refused, valid one lands", async (ui) => {
  ui.submit.click();
  await ui.settle();
  assert(ui.emailError.text.length > 0, "an empty email must show its rule");
  await ui.expectCell(signup, (s) => s.accepted.length === 0);

  ui.EmailInput.type("sita@example.com");
  ui.PasswordInput.type("hunter2hunter2");
  ui.submit.click();
  await ui.expectCell(signup, (s) => s.accepted.length === 1);
  assertEquals(ui.emailError.text, "");
});
`,
  4: `
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import { likes } from "../src/cell/likes.ts";
import LikeButton from "../src/LikeButton.tsx";

testUI(LikeButton, "recipe 4: the count moves before the method finishes", async (ui) => {
  ui.like.click();
  await ui.waitFor(() => ui.count.text === "1");
  // …and the optimistic layer is dropped once the real value catches up.
  await ui.expectCell(likes, (s) => s.count === 1);
  await ui.settle();
  assertEquals(ui.count.text, "1");
});
`,
  5: `
import { testCell } from "aio/testing";
import { bench } from "../src/cell/bench.ts";

testCell(bench, "recipe 5: both siblings land in one commit", async (t) => {
  await t.send.run();
  t.expect.state(
    (s) => s.samples.length === 2 && s.status === "done",
    "two samples, one action",
  );
  t.expect.state((s) => s.samples[0]!.kind === "cold");
});
`,
  6: `
import { assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { weather } from "../src/cell/weather.ts";
import * as api from "../src/cell/weather-api.ts";

Deno.test("recipe 6: an identical call inside the ttl does not re-run", async () => {
  const h = await bootCells([weather]);
  try {
    await weather.load("oslo");
    await weather.load("oslo");
    assertEquals(weather.loads, 1, "the second call was answered from cache");
    assertEquals(api.calls, 1, "…so the wrapped fetch ran once");
    await weather.load("lima");
    assertEquals(weather.loads, 2, "a DIFFERENT argument is a different call");
    await h.advance(31_000);
    await weather.load("oslo");
    assertEquals(weather.loads, 3, "the entry expired");
  } finally {
    h.dispose();
  }
});
`,
  7: `
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { search } from "../src/cell/search.ts";

Deno.test("recipe 7: the older search loses", async () => {
  const h = await bootCells([search]);
  try {
    const first = search.run("aa");
    const second = search.run("bb");
    await h.advance(200);
    await Promise.allSettled([first, second]);
    assertEquals(search.query, "bb");
    assert(
      search.hits.every((x: string) => x.startsWith("bb")),
      "the superseded call must not write its results: " + search.hits.join(),
    );
  } finally {
    h.dispose();
  }
});
`,
  8: `
import { assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { article } from "../src/cell/article.ts";

Deno.test("recipe 8: close() aborts the in-flight open()", async () => {
  const h = await bootCells([article]);
  try {
    const opening = article.open("7");
    await article.close();
    await h.advance(2000);
    await Promise.allSettled([opening]);
    assertEquals(article.body, "", "the cancelled load must not land late");
    assertEquals(article.loading, false);
  } finally {
    h.dispose();
  }
});
`,
  9: `
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { digest } from "../src/cell/digest.ts";

Deno.test("recipe 9: the interval fires on the virtual clock", async () => {
  const h = await bootCells([digest]);
  try {
    await digest.start();
    assertEquals(digest.ticks, 0, "nothing fires before the first interval");
    await h.advance(300_000);
    assert(digest.ticks >= 1, "one interval elapsed, one tick");
    const after = digest.ticks;
    await h.advance(300_000);
    assert(digest.ticks > after, "…and it repeats");
    await digest.stop();
    const stopped = digest.ticks;
    await h.advance(900_000);
    assertEquals(digest.ticks, stopped, "cancel(id) must really stop it");
  } finally {
    h.dispose();
  }
});
`,
  10: `
import { assertEquals } from "@std/assert";
import { migratePrefs, type Prefs } from "../src/cell/prefs.ts";

Deno.test("recipe 10: v1 data becomes v2 data", () => {
  const v1 = { dark: true } as unknown as Prefs;
  assertEquals(migratePrefs(v1, 1), { theme: "dark", tags: [] });
  const v2: Prefs = { theme: "light", tags: ["a"] };
  assertEquals(migratePrefs(v2, 2), v2, "a current version is left alone");
});
`,
  11: `
import { assert } from "@std/assert";
import { testMultiClient } from "aio/testing";
import { vault } from "../src/cell/vault.ts";

Deno.test("recipe 11: the secret is off the wire AND the door is shut", async () => {
  await using m = await testMultiClient({ cells: [vault] }, 1);
  const client = m.clients[0]!;
  const seen = client.state<Record<string, unknown>>("vault");
  assert("label" in seen, "the visible field must arrive: " + JSON.stringify(seen));
  assert(!("apiKey" in seen), "the excluded field must NOT: " + JSON.stringify(seen));

  let refused = false;
  try {
    await client.call("vault", "reveal");
  } catch {
    refused = true;
  }
  assert(refused, "access: false must refuse a call arriving over a socket");
});
`,
  12: `
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import NoteList from "../src/NoteList.tsx";

testUI(NoteList, "recipe 12: sita sees sita's rows", {
  user: { id: "sita", role: "user" },
}, (ui) => {
  assertEquals(ui.notes.text, "mine");
});

testUI(NoteList, "recipe 12: bo sees bo's", {
  user: { id: "bo", role: "user" },
}, (ui) => {
  assertEquals(ui.notes.text, "theirs");
});
`,
  13: `
import { assert } from "@std/assert";
import { testUI } from "aio/testing";
import Account from "../src/Account.tsx";

testUI(Account, "recipe 13: the signed-in branch renders the identity", {
  user: { id: "sita", role: "admin" },
}, (ui) => {
  assert(ui.status.text.includes("sita"), ui.status.text);
  assert(ui.status.text.includes("admin"), ui.status.text);
});
`,
  14: `
import { assert, assertEquals } from "@std/assert";
import { testServer } from "aio/testing";
import { tasks } from "../src/cell/tasks.ts";
import { apiRoutes } from "../src/routes/api.ts";

Deno.test("recipe 14: the JSON endpoint answers over real HTTP", async () => {
  await using srv = await testServer({ cells: [tasks], routes: apiRoutes });
  await tasks.add("write it down");

  const list = await srv.fetch("/api/tasks");
  assertEquals(list.status, 200);
  const body = await list.json() as { items: { id: number; done: boolean }[] };
  assertEquals(body.items.length, 1);

  const bad = await srv.fetch("/api/tasks/nope/done", { method: "POST" });
  assertEquals(bad.status, 400);
  await bad.body?.cancel();

  const ok = await srv.fetch("/api/tasks/1/done", { method: "POST" });
  assertEquals(ok.status, 200);
  await ok.json();
  assert(tasks.items[0]!.done, "the route reached the method");
});
`,
  15: `
import { assert, assertEquals } from "@std/assert";
import { testServer } from "aio/testing";
import { files } from "../src/cell/files.ts";
import { uploadRoutes } from "../src/routes/upload.ts";

Deno.test("recipe 15: bytes to disk, metadata to the cell", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-cookbook-uploads-" }); // aio-ok: the recipe's own storage dir, removed below
  try {
    await using srv = await testServer({
      cells: [files],
      routes: uploadRoutes(dir),
    });

    const form = new FormData();
    form.set("file", new File(["hello bytes"], "notes.txt"));
    const up = await srv.fetch("/upload", { method: "POST", body: form });
    assertEquals(up.status, 200);
    const { id } = await up.json() as { id: string };

    assertEquals(files.items.length, 1);
    assertEquals(files.items[0]!.name, "notes.txt");
    assertEquals(files.items[0]!.size, 11);

    const back = await srv.fetch("/uploads/" + id);
    assertEquals(await back.text(), "hello bytes");

    const empty = new FormData();
    empty.set("file", new File([], "nothing.txt"));
    const refused = await srv.fetch("/upload", { method: "POST", body: empty });
    assertEquals(refused.status, 400);
    await refused.json();

    // An encoded traversal reaches the handler as \`../etc/passwd\` — the
    // decode is what makes a :param dangerous, and the recipe's check is
    // what makes it safe.
    const bad = await srv.fetch("/uploads/" + encodeURIComponent("../etc/passwd"));
    assertEquals(bad.status, 400, "a path-shaped id must be refused");
    await bad.json();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
`,
  16: `
import { assertEquals } from "@std/assert";
import { navigate } from "aio/air";
import { testUI } from "aio/testing";
import PostPage from "../src/PostPage.tsx";

Deno.test("recipe 16: the title follows the route", async () => {
  await using ui = await testUI(PostPage);
  navigate("/posts/1");
  await ui.settle();
  assertEquals(ui.post.text, "Hello");
  assertEquals(globalThis.document.title, "Hello — Notes");

  navigate("/posts/missing");
  await ui.settle();
  assertEquals(globalThis.document.title, "Notes");
});
`,
  17: `
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import { palette } from "../src/cell/palette.ts";
import Palette from "../src/Palette.tsx";

testUI(Palette, "recipe 17: Escape reaches a binding no element owns", async (ui) => {
  await palette.open();
  await ui.settle();
  assertEquals(ui.paletteState.text, "open");
  await ui.paletteState.press("Escape");
  assertEquals(ui.paletteState.text, "closed");
});
`,
  18: `
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import { view } from "../src/cell/view.ts";
import * as media from "../src/media.ts";
import CameraView from "../src/CameraView.tsx";

Deno.test("recipe 18: one open per key, and every open is closed", async () => {
  {
    await using ui = await testUI(CameraView);
    await ui.waitFor(() => ui.cam.text === "live");
    assertEquals(media.opens, 1);
    assertEquals(media.closes, 0, "a re-render must NOT reopen the device");

    await view.setQuery("back");
    await ui.waitFor(() => media.opens === 2);
    assertEquals(media.closes, 1, "the old key closes when the key changes");
  }
  // The holder is gone — the last open is released.
  assertEquals(media.closes, media.opens, "every open was matched by a close");
});
`,
  19: `
import { assert } from "@std/assert";
import { testUI } from "aio/testing";
import Dashboard from "../src/Dashboard.tsx";

testUI(Dashboard, "recipe 19: the panel fails, the page lives", (ui) => {
  const html = ui.html();
  assert(html.includes("Panel failed: no data"), html);
  assert(html.includes("still here"), "the rest of the tree must still render");
});
`,
  20: `
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { thumbs } from "../src/cell/thumbs.ts";

Deno.test("recipe 20: a worker cell is called like any other", async () => {
  const h = await bootCells([thumbs]);
  try {
    const hash = await thumbs.hash("a thumbnail");
    assertEquals(thumbs.done, 1);
    assert(typeof hash === "number" && hash !== 0, String(hash));
    assertEquals(thumbs.lastHash, hash, "the return crossed the boundary");
  } finally {
    h.dispose();
  }
});
`,
};

// ── The project the drivers run in ───────────────────────────────────

function importMap(): Record<string, string> {
  const cfg = JSON.parse(
    Deno.readTextFileSync(new URL("deno.json", ROOT)),
  ) as { exports: Record<string, string>; imports: Record<string, string> };
  const imports: Record<string, string> = {};
  for (const [key, target] of Object.entries(cfg.exports)) {
    imports[key === "." ? "aio" : "aio/" + key.slice(2)] =
      new URL(target, ROOT).href;
  }
  for (const [key, target] of Object.entries(cfg.imports)) {
    if (imports[key]) continue;
    imports[key] = target.startsWith("./")
      ? new URL(target, ROOT).href
      : target;
  }
  imports["@std/assert"] ??= "jsr:@std/assert@1";
  return imports;
}

Deno.test("cookbook: every recipe is whole, and every recipe runs", async () => {
  const text = await Deno.readTextFile(new URL(DOC, ROOT));
  const recipes = parseCookbook(text);

  assertEquals(
    recipes.length,
    RECIPE_COUNT,
    `${DOC} promises ${RECIPE_COUNT} recipes in its title`,
  );
  assertEquals(
    recipes.map((r) => r.n),
    Array.from({ length: RECIPE_COUNT }, (_, i) => i + 1),
    "recipes must be numbered 1..N with no gap — the contents table links them",
  );

  // Every recipe carries code, every path is claimed once (the type-check gate
  // lays same-doc snippets out as ONE project, so a duplicate path would make
  // a later recipe silently check against an earlier one's file).
  const seen = new Map<string, number>();
  for (const r of recipes) {
    assert(r.files.length > 0, `${DOC} recipe ${r.n} has no code block`);
    for (const f of r.files) {
      const first = seen.get(f.path);
      assert(
        first === undefined,
        `${DOC}: ${f.path} is claimed by recipe ${first} and recipe ${r.n}`,
      );
      seen.set(f.path, r.n);
    }
  }

  // The honesty gate: a recipe whose last mile a test cannot reach must SAY so
  // in its own section, and a recipe that says so must be on the list.
  for (const r of recipes) {
    const says = /illustrative/i.test(r.body);
    assertEquals(
      says,
      ILLUSTRATIVE_LAST_MILE.has(r.n),
      says
        ? `${DOC} recipe ${r.n} calls itself illustrative but is not declared ` +
          `one here — add it, or drive the claim`
        : `${DOC} recipe ${r.n} is declared illustrative but its section never ` +
          `tells the reader. No silent exceptions.`,
    );
    assert(
      DRIVERS[r.n],
      `${DOC} recipe ${r.n} (${r.title}) has no driver — every recipe is run`,
    );
  }
  for (const n of Object.keys(DRIVERS).map(Number)) {
    assert(
      recipes.some((r) => r.n === n),
      `DRIVERS has an entry for recipe ${n}, which the doc no longer has`,
    );
  }

  // The page must be reachable: generated index + the section's hand-written
  // door. A cookbook nobody is pointed at is a cookbook nobody reads.
  const index = await Deno.readTextFile(new URL("docs/content.md", ROOT));
  assert(
    index.includes("basics/cookbook.md"),
    "docs/content.md does not list the cookbook — run `deno task update:docs`",
  );
  const readme = await Deno.readTextFile(
    new URL("docs/basics/README.md", ROOT),
  );
  assert(
    readme.includes("cookbook.md"),
    "docs/basics/README.md does not link the cookbook",
  );

  // ── Lay the page out as an app, add the drivers, run them ──────────
  const dir = await tempDir("aio-cookbook-");
  try {
    for (const r of recipes) {
      for (const f of r.files) {
        const abs = `${dir}/${f.path}`;
        await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(abs, f.code);
      }
    }
    for (const [path, body] of Object.entries(SUPPORT)) {
      assert(
        !seen.has(path),
        `${path} is both a support file and a recipe file — the doc now ` +
          `defines it, so delete the stand-in`,
      );
      await Deno.writeTextFile(`${dir}/${path}`, body.trimStart());
    }
    await Deno.mkdir(`${dir}/drive`);
    for (const [n, body] of Object.entries(DRIVERS)) {
      await Deno.writeTextFile(
        `${dir}/drive/r${n.padStart(2, "0")}.test.tsx`,
        body.trimStart(),
      );
    }
    const repoCfg = JSON.parse(
      Deno.readTextFileSync(new URL("deno.json", ROOT)),
    ) as { compilerOptions: Record<string, unknown> };
    const { jsx, jsxImportSource, lib, strict } = repoCfg.compilerOptions;
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: importMap(),
        compilerOptions: { jsx, jsxImportSource, lib, strict },
      }),
    );

    // `--no-check`: types are `docs-snippets-check.test.ts`'s question, and one
    // question gets one decider. This child answers the behavioural one.
    // `--parallel`: one worker per driver file, so two recipes that use the
    // same cell definition cannot share a runtime.
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "-A",
        "--no-check",
        "--parallel",
        "--no-lock",
        "--config",
        `${dir}/deno.json`,
        `${dir}/drive/`,
      ],
      cwd: dir,
      env: {
        ...Deno.env.toObject(),
        NO_COLOR: "1",
        DENO_JOBS: "4",
        AIO_TEST_HOME: `${dir}/home`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!run.success) {
      const dec = new TextDecoder();
      const report = (dec.decode(run.stdout) + dec.decode(run.stderr))
        .replaceAll(dir, "<cookbook>");
      assert(
        false,
        `a cookbook recipe does not do what ${DOC} says it does — the page ` +
          `is the source, so fix the RECIPE (or the driver's claim), never ` +
          `the copy on disk:\n${report}`,
      );
    }
  } finally {
    await dropTempDir(dir);
  }
});

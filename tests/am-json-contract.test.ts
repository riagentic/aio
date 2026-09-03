// `--json` means ONE JSON document on stdout, for every verb, success or
// failure. Three ways it was not true:
//
//  1. `am pin --json` and `am link --json` printed `aio: local path pin → …`
//     first — the framework's pin reader announces itself through `log.info`,
//     and the console formatter sends info to STDOUT. Neither command's output
//     parsed as JSON at all.
//  2. `am theme --json` bypassed the contract entirely: console.error +
//     exit(1), so stdout was empty and the usage text landed on stderr, while
//     every other verb answers `{"error":…}` on stdout.
//  3. Errors carried a double prefix — `{"error":"Error: am does not know
//     which app…"}` — because `outError(String(e))` keeps the constructor name
//     the pretty branch strips.
//
// Driven through a REAL process: an in-process test cannot observe which
// stream a line went to, and the stream is the whole finding.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { outError } from "../src/am/am-output.ts";
import { AM_STDERR_SINK } from "../src/am/am-log.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

type Ran = { code: number; stdout: string; stderr: string };

async function am(cwd: string, apps: string, ...args: string[]): Promise<Ran> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, AM, ...args],
    cwd,
    env: {
      ...Deno.env.toObject(),
      AIO_APPS_DIR: apps,
      // The pinned checkout IS this repo; delegating would re-exec the same am.
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

/** A project whose framework pin is this checkout — the shape that made the
 *  pin reader talk. */
async function pinnedProject(root: string): Promise<string> {
  const dir = join(root, "app");
  await Deno.mkdir(join(dir, ".aio"), { recursive: true });
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ appId: "jsonapp" }, null, 2),
  );
  await Deno.writeTextFile(join(dir, ".aio", "pin.local"), REPO + "\n");
  await Deno.writeTextFile(join(dir, "src", "app.ts"), "// entry\n");
  return dir;
}

async function withTemp<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "am-json-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

/** The whole of stdout must be the document — not "the last line of it". */
function onlyDocument(r: Ran, what: string): Record<string, unknown> {
  const text = r.stdout.trim();
  assert(text.length > 0, `${what}: stdout was empty (stderr: ${r.stderr})`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(
      `${what}: stdout is not one JSON document — a log line got in:\n${
        text.slice(0, 300)
      }`,
    );
  }
  assert(
    doc !== null && typeof doc === "object" && !Array.isArray(doc),
    `${what}: --json must answer with an object, got ${text.slice(0, 80)}`,
  );
  return doc as Record<string, unknown>;
}

Deno.test({
  name: "am --json: the framework's own log lines never reach stdout",
  fn: async () => {
    await withTemp(async (root) => {
      const dir = await pinnedProject(root);
      const apps = join(root, "apps");
      const r = await am(dir, apps, "pin", "--json");
      const doc = onlyDocument(r, "am pin --json");
      assertEquals(doc.pinned, `path:${REPO}`);
      // The line is not lost — it moved to the stream meant for it.
      assertStringIncludes(r.stderr, "local path pin");
    });
  },
});

Deno.test({
  name: "am theme --json: a refusal is {error} on stdout, like every verb",
  fn: async () => {
    await withTemp(async (root) => {
      const dir = await pinnedProject(root);
      const apps = join(root, "apps");
      const r = await am(dir, apps, "theme", "--json");
      assertEquals(r.code, 1, "a refusal exits non-zero");
      const doc = onlyDocument(r, "am theme --json");
      assertStringIncludes(String(doc.error), "unknown subcommand");
      assertStringIncludes(String(doc.error), "am theme adopt");
    });
  },
});

Deno.test({
  name: "am --json: an unknown flag is refused the same way by every verb",
  fn: async () => {
    await withTemp(async (root) => {
      const dir = await pinnedProject(root);
      const apps = join(root, "apps");
      // The three behaviours this replaces: refuse / ignore / read as an arg.
      for (const verb of ["status", "state", "instances", "top", "snapshot"]) {
        const r = await am(dir, apps, verb, "--zzz", "--json");
        assertEquals(r.code, 1, `am ${verb} --zzz should fail`);
        const doc = onlyDocument(r, `am ${verb} --zzz`);
        assertStringIncludes(String(doc.error), "unknown flag --zzz");
      }
      // …and a near miss says what was probably meant.
      const near = await am(dir, apps, "status", "--lnies=5", "--json");
      assertStringIncludes(
        String(onlyDocument(near, "typo").error),
        "did you mean --lines?",
      );
    });
  },
});

// `outError(String(e))` is how a caught exception reaches the output layer, and
// `String(e)` is `"Error: <message>"`. The pretty branch stripped that; the
// json branch shipped it.
Deno.test("am --json: an error document carries the message, not the class", () => {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    outError(String(new Error("am does not know which app to target")), "json");
    outError(String(new TypeError("x is not a function")), "json");
  } finally {
    console.log = real;
  }
  assertEquals(JSON.parse(lines[0]!), {
    error: "am does not know which app to target",
  });
  assertEquals(JSON.parse(lines[1]!), { error: "x is not a function" });
});

// The sink itself, unit-tested: every level `am` shows goes to stderr, and the
// quiet levels stay quiet.
Deno.test("am's log sink writes to stderr at info and above", () => {
  const seen: Array<["log" | "err", string]> = [];
  const [l, e] = [console.log, console.error];
  console.log = (...a: unknown[]) => seen.push(["log", a.join(" ")]);
  console.error = (...a: unknown[]) => seen.push(["err", a.join(" ")]);
  try {
    AM_STDERR_SINK.pub("info", "aio", "a pin line");
    AM_STDERR_SINK.pub("warn", "aio", "a warning");
    AM_STDERR_SINK.pub("error", "aio", "a failure");
    AM_STDERR_SINK.pub("debug", "aio", "chatter");
  } finally {
    console.log = l;
    console.error = e;
  }
  assertEquals(seen.filter(([s]) => s === "log"), []);
  assertEquals(seen.length, 3, "debug is not shown, the other three are");
  assertStringIncludes(seen[0]![1], "a pin line");
});

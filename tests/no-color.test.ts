// NO_COLOR, and one decider for it.
//
// aio emitted ANSI unconditionally from four modules, so `app > log.txt`,
// a CI transcript and `am … | grep` all carried `\x1b[31m` around every word,
// and the convention every other CLI follows did nothing here. The rule:
// colour is decoration — turning it off changes no character of the message.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ansi, colorEnabled, paint } from "../src/diagnostics/color.ts";
import { formatText } from "../src/diagnostics/logger-format.ts";

const ESC = "\x1b[";

/** Run a snippet in a child deno with a chosen environment, return its stdout. */
async function run(
  env: Record<string, string>,
  code: string,
): Promise<string> {
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(file, code);
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", file],
      env: { ...Deno.env.toObject(), ...env },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

const PRINT_LINE = `
import { log } from "${
  new URL("../src/diagnostics/logger-api.ts", import.meta.url).href
}";
log.warn("vitals", "broadcast rate is above the advisory threshold");
log.error("db", "a live-query subscriber threw");
log.info("aio", "started");
`;

Deno.test("no-color: NO_COLOR strips every escape, and keeps every word", async () => {
  const colored = await run({ FORCE_COLOR: "1" }, PRINT_LINE);
  const plain = await run({ NO_COLOR: "1", FORCE_COLOR: "" }, PRINT_LINE);

  assertStringIncludes(colored, ESC, "FORCE_COLOR must still colour");
  assert(!plain.includes(ESC), `NO_COLOR must strip ANSI, got: ${plain}`);

  // Same information, minus the escapes: strip them from the coloured run and
  // the two are identical apart from timestamps.
  const strip = (s: string) =>
    // deno-lint-ignore no-control-regex
    s.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\S+ \S+/gm, "").trim();
  assertEquals(
    strip(plain),
    strip(colored),
    "turning colour off must not change the message",
  );
  for (const word of ["broadcast rate", "WARN", "ERROR", "vitals", "db"]) {
    assertStringIncludes(plain, word);
  }
});

Deno.test("no-color: a pipe is not a terminal, so it gets no colour", async () => {
  // The child's stdout above IS a pipe, and nothing set FORCE_COLOR — so the
  // default (no env at all) must already be plain. This is the case that made
  // every redirected log unreadable.
  const piped = await run({ NO_COLOR: "", FORCE_COLOR: "" }, PRINT_LINE);
  assert(
    !piped.includes(ESC),
    `a non-terminal stdout must be plain, got: ${piped}`,
  );
});

Deno.test("no-color: the decision has ONE home", async () => {
  // Every module that emits a colour escape imports the decider. A second copy
  // of the rule is how one surface keeps colouring after the user said not to
  // — which is exactly how this repo ended up with four of them.
  const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const offenders: string[] = [];
  const walk = async function* (dir: string): AsyncGenerator<string> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) yield* walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) yield p;
    }
  };
  for await (const path of walk(`${REPO}/src`)) {
    const rel = path.slice(REPO.length + 1);
    if (rel === "src/diagnostics/color.ts") continue;
    const text = await Deno.readTextFile(path);
    // Colour codes only: `\x1b[2J` (clear screen) and cursor moves are TUI
    // control, not decoration, and stay whatever the colour setting is.
    if (!/\\x1b\[[0-9;]*m/.test(text)) continue;
    if (!/from "[^"]*color\.ts"/.test(text)) {
      offenders.push(rel);
    }
  }
  assertEquals(
    offenders,
    [],
    `these emit ANSI colour without asking color.ts whether colour is on:\n  ` +
      offenders.join("\n  "),
  );
});

Deno.test("no-color: the helpers agree with the flag", () => {
  // In this test process stdout is a pipe, so colour is off unless the runner
  // forced it — either way the two helpers must not disagree.
  assertEquals(ansi("\x1b[31m") !== "", colorEnabled);
  assertEquals(paint("x", "\x1b[31m") !== "x", colorEnabled);
  // The FILE formatter never colours, whatever the terminal says: app.log is
  // read by grep, and escapes in it are corruption.
  assert(
    !formatText({
      ts: "00:00:00",
      lvl: "error",
      cat: "aio",
      msg: "boom",
    }).includes(ESC),
  );
});

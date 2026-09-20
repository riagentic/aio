// What `am start` is allowed to read out of an app's own `dev` task.
//
// `entryTaskWords` exists because the cli scaffold's entry routes on
// `Deno.args[0]` and only `deno task dev` was ever told the word. It reads the
// task as a shell line and keeps every token after the entry that does not
// start with `-` — which is true of a shell operator, of the tail of a quoted
// value, and of a variable reference:
//
//   deno run -A src/app.ts serve --title="My App"   → serve, App"
//   deno run -A src/app.ts serve && echo done       → serve, &&, echo, done
//   deno run -A src/app.ts > out.log 2>&1           → >, out.log, 2>&1
//
// Those words go straight into the child's argv, so `am start` launches the
// very failure the fix was written to remove — a template whose entry validates
// its command word now dies on `&&` instead of on nothing. And a task that
// merely QUOTES its entry (`deno run -A "src/app.ts" serve`) matched no token
// at all, so the word was silently dropped and the cli scaffold was broken
// again, quietly.
//
// The rule: the words are the plain positional arguments of THIS command. A
// shell operator ends the command, so it ends the words.
import { assertEquals } from "@std/assert";
import { entryTaskWords } from "../src/am/am-cmd-process.ts";
import { join } from "@std/path";

const ROOT = "/proj";
const ENTRY = join(ROOT, "src/app.ts");
const words = (task: string | undefined) => entryTaskWords(task, ENTRY, ROOT);

Deno.test("am start: the plain command word is read", () => {
  assertEquals(words("deno run -A src/app.ts serve"), ["serve"]);
  assertEquals(words("deno run -A --watch src/app.ts serve"), ["serve"]);
  assertEquals(words("deno run -A src/app.ts"), []);
  assertEquals(words(undefined), []);
});

Deno.test("am start: an env prefix does not confuse the entry scan", () => {
  assertEquals(words("AIO_LOG=debug deno run -A src/app.ts serve"), ["serve"]);
});

Deno.test("am start: a quoted entry is still the entry", () => {
  // Silently returning [] here is the pre-fix bug back again: the cli
  // scaffold's command word is dropped and `am start` dies on "missing
  // command", which is exactly what this function was added to prevent.
  assertEquals(words('deno run -A "src/app.ts" serve'), ["serve"]);
  assertEquals(words("deno run -A 'src/app.ts' serve"), ["serve"]);
});

Deno.test("am start: the tail of a quoted flag value is not a command word", () => {
  assertEquals(words('deno run -A src/app.ts serve --title="My App"'), [
    "serve",
  ]);
  assertEquals(words("deno run -A src/app.ts serve --title='My App'"), [
    "serve",
  ]);
});

Deno.test("am start: a shell operator ends the command, so it ends the words", () => {
  for (
    const task of [
      "deno run -A src/app.ts serve && echo done",
      "deno run -A src/app.ts serve || true",
      "deno run -A src/app.ts serve ; echo done",
      "deno run -A src/app.ts serve | tee dev.log",
      "deno run -A src/app.ts serve & disown",
    ]
  ) {
    assertEquals(words(task), ["serve"], task);
  }
});

Deno.test("am start: a redirection is not an argument", () => {
  assertEquals(words("deno run -A src/app.ts > out.log 2>&1"), []);
  assertEquals(words("deno run -A src/app.ts serve > out.log"), ["serve"]);
});

// …and an ordinary argument am has not thought of is still passed on. The
// stop rule is a denylist of shell characters, not an allowlist of word
// shapes: dropping `mode=dev` or a non-ASCII command word would be the same
// silent divergence from `deno task dev`, in the other direction.
Deno.test("am start: an ordinary argument is not narrowed away", () => {
  assertEquals(words("deno run -A src/app.ts serve mode=dev"), [
    "serve",
    "mode=dev",
  ]);
  assertEquals(words("deno run -A src/app.ts démarrer"), ["démarrer"]);
  assertEquals(words("deno run -A src/app.ts serve conf/app.json"), [
    "serve",
    "conf/app.json",
  ]);
});

Deno.test("am start: a shell variable is never expanded into argv", () => {
  // am is not a shell. `$EXTRA` reaching the child as the literal five
  // characters is worse than not passing it: the app sees an argument its
  // author never wrote.
  assertEquals(words("deno run -A src/app.ts $EXTRA"), []);
  assertEquals(words("deno run -A src/app.ts serve $EXTRA"), ["serve"]);
  assertEquals(words("deno run -A src/app.ts `date`"), []);
});

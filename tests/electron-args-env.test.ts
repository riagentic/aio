// `AIO_ELECTRON_ARGS` — the switch half of "make it start on this VM".
//
// A field report's console crash-looped on a GPU abort every ~90 seconds until
// the machine got `LIBGL_ALWAYS_SOFTWARE=1` (quant §7, §9.7). Environment
// variables already reached Electron, because the spawn inherits them.
// Chromium SWITCHES — `--disable-gpu`, `--disable-dev-shm-usage` — had no way
// in at all, so half the documented remedy for a headless host was
// unreachable.
//
// The interesting decision is the refusal. This lands in `argv`, never in a
// shell, so the risk is not injection — it is a typo Chromium ignores in
// silence, on the one kind of host where nobody can see the window to notice.
// So a token that is not a switch is named in the log rather than dropped.
import { assert, assertEquals } from "@std/assert";
import { electronArgsFromEnv } from "../src/electron/electron-spawn.ts";

Deno.test("the documented sets parse, exactly and in order", () => {
  assertEquals(
    electronArgsFromEnv("--disable-gpu --disable-dev-shm-usage"),
    { args: ["--disable-gpu", "--disable-dev-shm-usage"], refused: [] },
  );
  assertEquals(
    electronArgsFromEnv("--use-gl=swiftshader").args,
    ["--use-gl=swiftshader"],
    "a --key=value switch is the other half of the vocabulary",
  );
  // Order is preserved: Chromium takes the LAST occurrence of a repeated
  // switch, so an operator overriding one of aio's own depends on it.
  assertEquals(
    electronArgsFromEnv("--a --b --a=2").args,
    ["--a", "--b", "--a=2"],
  );
});

Deno.test("whitespace is whatever the shell left behind", () => {
  assertEquals(electronArgsFromEnv("  --a \t\n --b  ").args, ["--a", "--b"]);
  assertEquals(electronArgsFromEnv(""), { args: [], refused: [] });
  assertEquals(electronArgsFromEnv(undefined), { args: [], refused: [] });
  assertEquals(electronArgsFromEnv("   "), { args: [], refused: [] });
});

Deno.test("anything that is not a switch is REFUSED, not dropped", () => {
  // Each of these is a real way to get it wrong, and every one of them would
  // otherwise be a silent no-op on a machine with no visible window.
  for (
    const bad of [
      "disable-gpu", // forgot the dashes
      "-disable-gpu", // one dash
      "--", // nothing after it
      "rm", // a bare word
      "/tmp/x", // a path
      "--=1", // no name
    ]
  ) {
    const r = electronArgsFromEnv(bad);
    assertEquals(r.args, [], `"${bad}" was accepted as a switch`);
    assertEquals(r.refused, [bad], `"${bad}" was dropped without a word`);
  }
});

Deno.test("a good switch beside a bad one still goes through", () => {
  // Refusing the whole variable over one typo would turn a warning into an
  // outage on the host that needs the other switch to boot at all.
  const r = electronArgsFromEnv("--disable-gpu oops --use-gl=swiftshader");
  assertEquals(r.args, ["--disable-gpu", "--use-gl=swiftshader"]);
  assertEquals(r.refused, ["oops"]);
});

Deno.test("the spawn appends them LAST, after aio's own", async () => {
  // Order is the whole reason an override works, and it is decided at the
  // call site rather than in the parser — so it is asserted there.
  const src = await Deno.readTextFile(
    new URL("../src/electron/electron-spawn.ts", import.meta.url),
  );
  const line = src.split("\n").find((l) => l.includes("args: [tmpFile,"))!;
  assert(line, "the spawn's args list moved");
  assert(
    line.indexOf("envArgs.args") > line.indexOf("sandboxArgs"),
    `the env switches must come after aio's own: ${line.trim()}`,
  );
});

Deno.test("the docs do not hand out --no-sandbox", async () => {
  // aio adds it ITSELF, and only after measuring that the kernel restricts
  // user namespaces and chrome-sandbox is not setuid-root. A copy-pasteable
  // `--no-sandbox` gives away isolation on every host, including the many
  // that never needed it.
  const doc = await Deno.readTextFile(
    new URL("../docs/clients/electron.md", import.meta.url),
  );
  const section = doc.slice(doc.indexOf("## Headless and VM hosts"));
  const body = section.slice(0, section.indexOf("\n## ", 10));
  const argLines = body.split("\n").filter((l) =>
    l.includes("AIO_ELECTRON_ARGS=")
  );
  // Asserted BEFORE the loop: the day someone renames the variable is the day
  // a loop over nothing starts reporting success.
  assert(
    argLines.length >= 3,
    `only ${argLines.length} AIO_ELECTRON_ARGS lines in the section`,
  );
  for (const line of argLines) {
    assertEquals(
      line.includes("--no-sandbox"),
      false,
      `a copy-pasteable --no-sandbox: ${line.trim()}`,
    );
  }
  assert(
    body.includes("LIBGL_ALWAYS_SOFTWARE=1"),
    "the one remedy the report actually needed must be in the set",
  );
  assert(
    body.includes("xvfb"),
    "a switch cannot substitute for a display — the doc has to say so",
  );
});

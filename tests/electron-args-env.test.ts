// `AIO_ELECTRON_ARGS` — the switch half of "make it start on this VM".
//
// A field report's console crash-looped on a GPU abort every ~90 seconds until
// the machine got `LIBGL_ALWAYS_SOFTWARE=1` (report 2 §7, §9.7). Environment
// variables already reached Electron, because the spawn inherits them.
// Chromium SWITCHES — `--disable-gpu`, `--disable-dev-shm-usage` — had no way
// in at all, so half the documented remedy for a headless host was
// unreachable.
//
// The interesting decision is the refusal. This lands in `argv`, never in a
// shell, so the risk is not injection — it is a typo Chromium ignores in
// silence, on the one kind of host where nobody can see the window to notice.
// So a token that is not a switch is named in the log rather than dropped.
//
// …and that was the whole gate, which an audit (§7) measured against the wrong
// threat: the variable took ANY `--switch` and was appended LAST, so it
// overrode aio's own. Whoever controls the launch environment — a .desktop
// file, a shell profile, a wrapper script — could add
// `--remote-debugging-port=9222` and have unauthenticated CDP against the
// renderer: arbitrary JavaScript in the page, in a packaged app, with nothing
// in the app's own config able to prevent it. `--disable-web-security` and
// `--js-flags` were equally available.
//
// So the set is an ALLOW-LIST now: the display/GPU/logging vocabulary a
// headless or VM host actually needs. Deny-listing Chromium's flags is a game
// nobody wins — there are hundreds and they change every release.
import { assert, assertEquals } from "@std/assert";
import {
  ELECTRON_ARGS_ALLOWED,
  electronArgsFromEnv,
} from "../src/electron/electron-spawn.ts";

/** The tokens that survived, by name. */
const args = (raw: string) => electronArgsFromEnv(raw).args;
/** Why each token was refused, keyed by the token. */
const why = (raw: string) =>
  Object.fromEntries(
    electronArgsFromEnv(raw).refused.map((r) => [r.tok, r.why]),
  );

Deno.test("the documented sets parse, exactly and in order", () => {
  assertEquals(
    electronArgsFromEnv("--disable-gpu --disable-dev-shm-usage"),
    { args: ["--disable-gpu", "--disable-dev-shm-usage"], refused: [] },
  );
  assertEquals(
    args("--use-gl=swiftshader"),
    ["--use-gl=swiftshader"],
    "a --key=value switch is the other half of the vocabulary",
  );
  assertEquals(
    args("--enable-unsafe-swiftshader"),
    ["--enable-unsafe-swiftshader"],
    "the switch a GPU-less display needs for WebGL must keep working",
  );
  // Order is preserved: Chromium takes the LAST occurrence of a repeated
  // switch, so an operator overriding one of aio's own depends on it.
  assertEquals(
    args("--disable-gpu --lang=fr --disable-gpu=1"),
    ["--disable-gpu", "--lang=fr", "--disable-gpu=1"],
  );
});

Deno.test("the dangerous switches are REFUSED, each with its own reason", () => {
  // Every one of these is a real escalation, not a hypothetical: the first is
  // arbitrary JavaScript in the page of a packaged app, from an environment
  // variable, against a renderer holding the app's secrets.
  const cases: [string, string][] = [
    ["--remote-debugging-port=9222", "--cdp"],
    ["--remote-debugging-pipe", "--cdp"],
    ["--disable-web-security", "origin"],
    ["--js-flags=--allow-natives-syntax", "V8"],
    ["--no-sandbox", "requireSandbox"],
    ["--disable-setuid-sandbox", "requireSandbox"],
    ["--load-extension=/tmp/evil", "code"],
    ["--renderer-cmd-prefix=/tmp/evil", "program"],
    ["--proxy-server=http://127.0.0.1:1", "traffic"],
    ["--user-data-dir=/tmp/x", "profile"],
    ["--disable-features=IsolateOrigins", "mitigation"],
    ["--ignore-certificate-errors", "origin"],
  ];
  for (const [tok, needle] of cases) {
    assertEquals(args(tok), [], `${tok} reached Chromium`);
    const reason = why(tok)[tok];
    assert(reason, `${tok} was dropped without a word`);
    assert(
      reason.includes(needle),
      `the refusal of ${tok} must say why, and where to go: ${reason}`,
    );
  }
});

Deno.test("an unknown switch is refused too — the list is an ALLOW-list", () => {
  // The whole point: a switch nobody vetted does not ride in because nobody
  // thought to forbid it. The refusal has to point at the supported set.
  const r = why("--enable-blink-features=ShadowDOMV0");
  const reason = r["--enable-blink-features=ShadowDOMV0"]!;
  assert(reason, "an unlisted switch must be named, not dropped");
  assert(
    reason.includes("docs/clients/electron.md"),
    `…and point somewhere: ${reason}`,
  );
});

Deno.test("the allow-list holds no switch that turns a protection off", () => {
  // A property, not a spot check: the day someone widens the set, a name from
  // the escalation vocabulary cannot slip in with it.
  assert(
    ELECTRON_ARGS_ALLOWED.size >= 15,
    `the allow-list is ${ELECTRON_ARGS_ALLOWED.size} entries — a loop over an ` +
      `empty set proves nothing, and the documented remedies need these`,
  );
  for (const name of ELECTRON_ARGS_ALLOWED) {
    for (
      const banned of [
        "sandbox",
        "web-security",
        "debugging",
        "js-flags",
        "extension",
        "cmd-prefix",
        "proxy",
        "insecure",
        "certificate",
        "disable-features",
      ]
    ) {
      assert(
        !name.includes(banned),
        `--${name} is in the allow-list and reads like an escalation`,
      );
    }
  }
});

Deno.test("whitespace is whatever the shell left behind", () => {
  assertEquals(args("  --disable-gpu \t\n --lang=fr  "), [
    "--disable-gpu",
    "--lang=fr",
  ]);
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
    assertEquals(
      r.refused.map((x) => x.tok),
      [bad],
      `"${bad}" was dropped without a word`,
    );
    assert(
      r.refused[0]!.why.includes("--disable-gpu"),
      `a typo must be shown the shape of a switch: ${r.refused[0]!.why}`,
    );
  }
});

Deno.test("a good switch beside a bad one still goes through", () => {
  // Refusing the whole variable over one typo would turn a warning into an
  // outage on the host that needs the other switch to boot at all.
  const r = electronArgsFromEnv("--disable-gpu oops --use-gl=swiftshader");
  assertEquals(r.args, ["--disable-gpu", "--use-gl=swiftshader"]);
  assertEquals(r.refused.map((x) => x.tok), ["oops"]);
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
  // …and every switch the doc hands out must be one the allow-list takes. A
  // documented remedy that the code refuses is worse than no remedy: the
  // person copies it, nothing happens, and the log blames them.
  for (const line of argLines) {
    const raw = line.slice(line.indexOf("AIO_ELECTRON_ARGS=") + 18).replace(
      /"/g,
      "",
    );
    assertEquals(
      electronArgsFromEnv(raw).refused,
      [],
      `the docs hand out a switch this build refuses: ${line.trim()}`,
    );
  }
});

// ── The refusal has to be a refusal, not a spawn failure ───────────────────
//
// The allow-list screens the switch NAME. The VALUE was `[^\s]*`, which admits
// every control character there is — including NUL, the one byte that cannot
// survive `execve`. MEASURED, not reasoned: `new Deno.Command(bin, { args:
// ["--lang=en\0--no-sandbox"] })` throws
//
//     TypeError: Failed to spawn '…': nul byte found in provided data
//
// out of `spawnElectron`, so the window never opens and the message names
// neither the variable nor the token. "I set the flag and nothing changed" is
// the failure this validator exists to end, and "I set the flag and the app
// did not start, with a TypeError about bytes" is a worse version of it.
Deno.test("a switch carrying a control character is refused BY NAME", () => {
  const NUL = String.fromCharCode(0);
  for (
    const tok of [
      `--lang=en${NUL}--no-sandbox`,
      `--use-gl=sw${String.fromCharCode(27)}[2J`,
      `--ozone-platform=x${String.fromCharCode(7)}`,
    ]
  ) {
    const r = electronArgsFromEnv(tok);
    assertEquals(
      r.args,
      [],
      `a control character reached the spawn: ${JSON.stringify(tok)}`,
    );
    const reason = r.refused[0]?.why ?? "";
    assert(
      reason.includes("control character"),
      `the refusal must name what is wrong with it: ${reason}`,
    );
  }
  // …and the ordinary values are untouched.
  assertEquals(args("--lang=en-GB --use-gl=swiftshader"), [
    "--lang=en-GB",
    "--use-gl=swiftshader",
  ]);
});

Deno.test("every refusal reason is one aio wrote", () => {
  // The reasons live in a plain object literal, so `REFUSED[name]` also
  // answers for every key on `Object.prototype`. `--toString` came back with
  //
  //     "--toString": function toString() { [native code] } (AIO_ELECTRON_ARGS …)
  //
  // — refused, correctly, and then explained by V8. A refusal that reads like
  // an internal error is one the person cannot act on.
  for (
    const tok of [
      "--toString",
      "--constructor",
      "--valueOf",
      "--hasOwnProperty=x",
      "--isPrototypeOf",
      "--propertyIsEnumerable",
    ]
  ) {
    const r = electronArgsFromEnv(tok);
    assertEquals(r.args, [], `${tok} was accepted`);
    const reason = r.refused[0]!.why;
    assert(
      !reason.includes("[native code]") && !reason.includes("[object "),
      `the refusal of ${tok} came from Object.prototype: ${reason}`,
    );
    assert(
      reason.includes("docs/clients/electron.md"),
      `…and must point at the set: ${reason}`,
    );
  }
});

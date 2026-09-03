// What a flag's VALUE is allowed to look like — and what the boot report says
// the process was started with.
//
// `Number()` accepts far more spellings than a port is: `--port=0x1F90` became
// 8080 (hex, silently), `--port=3000.0`, `--port=+3000` and `--port= 3000`
// (the shell splitting an empty assignment) all coerced to something, and
// `--port=` became `Number("") === 0` — "pick a free port" — so an unset
// `$PORT` moved the app to an address nobody was told about. Meanwhile
// `--host=` was refused and `--title=`/`--db-path=` were not: one rule, three
// answers.
//
// And the `cli:` line of the boot report filtered `Deno.args` for `--`-words,
// which told two lies at once: a bare word or a short flag vanished from a
// line that claims to say how this process was started, and an app's own
// arguments after a bare `--` were listed as though aio had parsed them.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { cliLine, parseCli } from "../src/server/aio-cli.ts";
import { ENUM_VALUES } from "../src/server/config.ts";
import { childCoverageDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const _childCovDir = childCoverageDir();

// ── Numbers are decimal digits, or they are refused ───────────────────

Deno.test("--port: only a decimal port, never a Number() coercion", () => {
  assertEquals(parseCli(["--port=3000"]).port, 3000);
  // 0 stays the universal "pick one for me" — and leaves the port unset.
  assertEquals(parseCli(["--port=0"]).port, undefined);
  for (
    const bad of [
      "0x1F90",
      "3000.0",
      "+3000",
      " 3000",
      "3e3",
      "3_000",
      "-1",
      "70000",
      "8080abc",
    ]
  ) {
    assertThrows(
      () => parseCli([`--port=${bad}`]),
      Error,
      "--port",
      `--port=${bad} must be refused, not coerced`,
    );
  }
});

Deno.test("--width/--height/--cdp: the same digits-only rule", () => {
  assertEquals(parseCli(["--width=1200"]).width, 1200);
  assertEquals(parseCli(["--height=900"]).height, 900);
  assertEquals(parseCli(["--cdp=9333"]).cdp, 9333);
  for (const bad of ["0x10", "1e3", "800.0", "+800", "800px"]) {
    assertThrows(() => parseCli([`--width=${bad}`]), Error, "--width");
    assertThrows(() => parseCli([`--height=${bad}`]), Error, "--height");
    assertThrows(() => parseCli([`--cdp=${bad}`]), Error, "--cdp");
  }
});

// ── One rule for an empty value ───────────────────────────────────────

Deno.test("a flag typed with = and nothing after it is refused, whichever flag it is", () => {
  for (
    const f of [
      "--port",
      "--title",
      "--db-path",
      "--host",
      "--channel",
      "--client",
      "--transport",
      "--width",
    ]
  ) {
    const err = assertThrows(
      () => parseCli([`${f}=`]),
      Error,
      f,
      `${f}= must be refused like --host= always was`,
    );
    assertStringIncludes(String(err), "<value>");
  }
});

Deno.test("--isolate: commas with no names is not 'every cell'", () => {
  assertEquals(parseCli(["--isolate=todo,notes"]).isolate, ["todo", "notes"]);
  // A trailing comma is a typo, not a request: the names that ARE there stand.
  assertEquals(parseCli(["--isolate=todo,"]).isolate, ["todo"]);
  // …but nothing at all would have meant "run every cell" downstream, which is
  // the opposite of what the flag is for.
  assertThrows(() => parseCli(["--isolate=,"]), Error, "--isolate");
  assertThrows(() => parseCli(["--isolate= , "]), Error, "--isolate");
});

Deno.test("--server-url= points at the flag that MEANS the connect page", () => {
  const err = assertThrows(
    () => parseCli(["--server-url="]),
    Error,
    "--server-url",
  );
  assertStringIncludes(String(err), "--connect");
  // The real thing still parses.
  assertEquals(
    parseCli(["--server-url=https://10.0.0.5:8443"]).serverUrl,
    "https://10.0.0.5:8443",
  );
  // …and `--connect` is still the empty-string spelling internally.
  assertEquals(parseCli(["--connect"]).serverUrl, "");
});

// ── `--transport=auto`: one word, one vocabulary ──────────────────────

Deno.test("--transport accepts every word the config key accepts", () => {
  assertEquals(parseCli(["--transport=uds"]).transport, "uds");
  assertEquals(parseCli(["--transport=ws"]).transport, "ws");
  // Documented in docs/build/dev-mode.md and accepted by `aio.run({ transport })`
  // — and refused by the flag, which is the same word meaning two things.
  assertEquals(parseCli(["--transport=auto"]).transport, "auto");
  assertThrows(() => parseCli(["--transport=uxs"]), Error, "--transport");
});

// ── The `cli:` line ───────────────────────────────────────────────────

Deno.test("cliLine: verbatim — nothing typed is hidden", () => {
  assertEquals(cliLine([]), "");
  assertEquals(cliLine(["--port=3000", "--verbose"]), "--port=3000 --verbose");
  // The two the old filter dropped: a bare word and a short flag.
  assertEquals(cliLine(["serve", "-v", "--port=3000"]), "serve -v --port=3000");
  assertEquals(cliLine(["3000", "foo"]), "3000 foo");
});

Deno.test("cliLine: the `--` is printed, so it is visible where aio stopped", () => {
  assertEquals(
    cliLine(["--port=3000", "--", "--user=ana", "-n", "2"]),
    "--port=3000 -- --user=ana -n 2",
  );
  assert(
    cliLine(["--port=3000", "--", "--user=ana"]).includes(" -- "),
    "an app's own arguments must not read as flags aio parsed",
  );
});

// ── Short flags and positionals belong to the APP ─────────────────────
//
// They are not refused: `args()` (aio/cli) parses the same argv for the app,
// supports `short:` aliases and positionals, and refuses what IT does not
// know. Two parsers over one argv means aio's half must leave the app's half
// alone — so what was wrong was the HELP promising a refusal that never came,
// and the boot line hiding the words. Both now match the behaviour.

Deno.test("parseCli: a short flag or a bare word is left for the app, not swallowed", () => {
  for (const argv of [["-h"], ["-p", "9"], ["serve"], ["3000", "foo"]]) {
    const r = parseCli(argv);
    assertEquals(r.port, undefined, argv.join(" "));
    assertEquals(r.help, undefined, argv.join(" "));
  }
  // An unknown LONG flag is still refused — that promise is real.
  assertThrows(() => parseCli(["--experse"]), Error, "--experse");
});

// ── `--help` describes the parser it belongs to ───────────────────────

async function helpText(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-help-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "helpapp",
        imports: { aio: join(ROOT, "mod.ts") },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { aio, cell } from "aio";
cell("board", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: "helpapp", persist: false, singleton: false, client: "server-only" });
Deno.exit(0);
`,
    );
    const r = await new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: join(dir, "home") },
      args: ["run", "-A", join(dir, "src", "app.ts"), "--help"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return dec.decode(r.stdout) + dec.decode(r.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "--help: the 'settable in code' note sits under --expose, the flag it is about",
  async fn() {
    const help = await helpText();
    const lines = help.split("\n");
    const note = lines.findIndex((l) =>
      l.includes("aio.run({ expose: true })")
    );
    assert(note > 0, `note missing from --help:\n${help}`);
    // The line above it must be the flag it describes — it was printed under
    // `--channel=X`, which is a different feature entirely.
    const owner = lines.slice(0, note).reverse().find((l) =>
      /^\s+--/.test(l)
    ) ??
      "";
    assertStringIncludes(owner, "--expose");
  },
});

Deno.test({
  name: "--help: the refusal promise matches what the parser actually refuses",
  async fn() {
    const help = await helpText();
    // It used to promise that "an unknown flag" is refused, full stop — while
    // `-h`, `-v` and a bare `3000` all booted the app.
    assert(
      !/An unknown flag or an unusable value is REFUSED/.test(help),
      `--help promises a refusal the parser does not make:\n${help}`,
    );
    assertStringIncludes(help, 'An unknown "--flag"');
    // …and says where a short flag or a bare word actually goes.
    assertStringIncludes(help, "single-dash flag");
    assertStringIncludes(help, "--transport=X");
    assertStringIncludes(help, "auto");
  },
});

// ── One word, one vocabulary — flag, config key, and the doc ──────────
//
// `docs/build/dev-mode.md` documented `--transport=auto` as the DEFAULT while
// the flag parser refused the word and the config key accepted it: one word
// with two vocabularies and a doc describing neither. The three surfaces are
// compared here so a fourth spelling cannot be added to one of them alone.

const DEV_MODE_MD = new URL("../docs/build/dev-mode.md", import.meta.url);

/** The one table row documenting `flag`, from dev-mode.md. */
async function docRow(flag: string): Promise<string> {
  const md = await Deno.readTextFile(DEV_MODE_MD);
  const row = md.split("\n").find((l) =>
    l.startsWith("|") && l.includes(`\`${flag}`)
  );
  if (!row) throw new Error(`no dev-mode.md row for ${flag}`);
  return row;
}

Deno.test("--transport: flag, config key and doc name the SAME words", async () => {
  const allowed = ENUM_VALUES.transport!;
  // Named, not just iterated: an empty (or shrunken) list would make every
  // loop below vacuous, and this is the test that says what the vocabulary IS.
  assertEquals([...allowed].sort(), ["auto", "uds", "ws"]);
  for (const v of allowed) {
    assertEquals(
      parseCli([`--transport=${v}`]).transport,
      v,
      `the config key accepts "${v}" — the flag must too`,
    );
  }
  const row = await docRow("--transport=");
  const documented = [...row.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!);
  assertEquals(
    [...new Set(documented)].sort(),
    [...allowed].sort(),
    `dev-mode.md documents transport words the parser does not accept (or misses one): ${row}`,
  );
});

Deno.test("--expose: the doc describes the auth the app actually generates", async () => {
  const row = await docRow("--expose");
  // It said "no auth by default; `key: true` opts in" while the boot warned
  // that it had GENERATED a shared app key — the doc was describing the
  // pre-alpha52 behaviour, on the one flag where being wrong is a security
  // decision.
  assert(
    !/no auth by default/i.test(row),
    `dev-mode.md still says --expose has no auth: ${row}`,
  );
  assertStringIncludes(row.toLowerCase(), "app key");
});

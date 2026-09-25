// `am` inputs that were accepted and then DROPPED — each answered exit 0 (or
// did the real, mutating thing) as if the input had been honoured.
//
//   - `am fix --dry` ran the REAL repair: `fix` was PASSTHROUGH though it
//     forwards nothing, so its typo was nobody's to reject.
//   - `am publish --chanel=beta` / `--channel beta` published to PROD.
//   - `am auth create alice --role admin` created a plain user.
//   - `am timeline -n 1` / `am state -w`: one-dash flags were never judged.
//   - `am timeline 5`: a verb that reads no argument dropped it silently.
//   - `am dispatch t:m --body=` (an unset $VAR) called the method bare.
//   - `am create x --template counter`: "unknown flag --template".
//   - `am top 2s --json`: the interval was validated only at a terminal.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  misplacedFlagError,
  strayArgsWarning,
  unknownFlagError,
  unknownFlags,
} from "../src/am/am-flags.ts";
import { parseGlobalFlags } from "../src/am/am-utils.ts";
import { _authArgsError } from "../src/am/am-cmd-auth.ts";
import { parseCreateArgs } from "../src/am/am-cmd-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { DENO_DIR } from "./deno-dir-helper.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

/** `am <argv>` in a sandbox: empty cwd, temp HOME/runtime dirs, no display. */
async function am(
  argv: string[],
): Promise<{ code: number; out: string }> {
  const base = await tempDir("am-dropped-r2-");
  try {
    const cwd = join(base, "cwd");
    await Deno.mkdir(cwd);
    const env: Record<string, string> = {
      HOME: base,
      AIO_HOME: base,
      AIO_APPS_DIR: join(base, "apps"),
      AIO_INSTALL_ROOT: join(base, "install"),
      AIO_VERSIONS_DIR: join(base, "versions"),
      AIO_FEEDBACK_DIR: join(base, "feedback"),
      XDG_RUNTIME_DIR: join(base, "run"),
      AIO_AM_NO_DELEGATE: "1",
      PATH: Deno.env.get("PATH") ?? "",
      NO_COLOR: "1",
    };
    env.DENO_DIR = DENO_DIR;
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, AM, ...argv, "--json"],
      cwd,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return {
      code: o.code,
      out: dec.decode(o.stdout) + dec.decode(o.stderr),
    };
  } finally {
    await dropTempDir(base);
  }
}

Deno.test("am fix: a mistyped flag is refused, never a real repair", () => {
  const err = unknownFlagError("fix", ["--dry"]);
  assert(err !== null, "am fix --dry must be refused, not run for real");
  assert(err.includes("--dry-run"), `names the real flag: ${err}`);
  // Every flag cmdFix actually reads still passes.
  for (
    const f of ["--dry-run", "--check", "--no-download", "--migrate-tasks"]
  ) {
    assertEquals(unknownFlags("fix", [f]), [], f);
  }
  assertEquals(unknownFlags("fix", ["--aio", "/x"]), []);
  assertEquals(unknownFlags("fix", ["--aio=/x"]), []);
});

Deno.test("am publish: a mistyped flag is refused, --data is publish's own", () => {
  const err = unknownFlagError("publish", ["--chanel=beta"]);
  assert(err !== null, "--chanel=beta must not publish to prod");
  assert(err.includes("did you mean --channel"), err);
  for (
    const f of [
      "--channel=b",
      "--dir=d",
      "--targets=a",
      "--target=a",
      "--no-build",
      "--key=k",
      "--data=c.json",
      "--version=1",
      "--notes=n",
      "--min-from=1",
      "--allow-dirty",
    ]
  ) assertEquals(unknownFlags("publish", [f]), [], f);
  // `--data` is a global flag scoped to the verbs that read it; publish does.
  assertEquals(
    misplacedFlagError("publish", ["publish", "--data=c.json"]),
    null,
  );
});

Deno.test("am publish: --channel with a space is refused before any build", async () => {
  const r = await am(["publish", "--channel", "beta", "--no-build"]);
  assertEquals(r.code, 1, r.out);
  assert(r.out.includes("--channel takes its value with '='"), r.out);
  const s = await am(["publish", "beta", "--no-build"]);
  assertEquals(s.code, 1, s.out);
  assert(s.out.includes("takes no arguments"), s.out);
});

Deno.test("am auth: a field it would drop is refused", () => {
  const bare = _authArgsError("create", ["alice", "--role", "admin"]);
  assert(bare !== null && bare.includes("--role=<value>"), `${bare}`);
  const typo = _authArgsError("create", ["alice", "--emial=a@b.c"]);
  assert(typo !== null && typo.includes("unknown flag --emial"), `${typo}`);
  const extra = _authArgsError("create", ["alice", "admin"]);
  assert(extra !== null && extra.includes('"admin"'), `${extra}`);
  const noFlags = _authArgsError("unlock", ["alice", "--password=x"]);
  assert(noFlags !== null, "unlock reads no --password");
  // What each subcommand really reads passes.
  assertEquals(
    _authArgsError("create", [
      "alice",
      "--password=p-w=d",
      "--role=admin",
      "--email=a@b.c",
    ]),
    null,
  );
  assertEquals(_authArgsError("passwd", ["alice", "--password=x"]), null);
  assertEquals(_authArgsError("role", ["alice", "admin"]), null);
  assertEquals(_authArgsError("totp", ["alice", "off"]), null);
  assertEquals(_authArgsError("users", []), null);
  assertEquals(_authArgsError("nope", ["x", "y", "--z"]), null);
});

Deno.test("am flags: an unknown one-dash flag is refused like a two-dash one", () => {
  assertEquals(unknownFlags("timeline", ["-n", "1"]), ["-n"]);
  assertEquals(unknownFlags("state", ["-w"]), ["-w"]);
  assertEquals(unknownFlags("status", ["-x"]), ["-x"]);
  // A verb's own short flag, a negative number, and free VALUES pass.
  assertEquals(unknownFlags("prune", ["-y"]), []);
  assertEquals(unknownFlags("timetravel", ["goto", "-1"]), []);
  assertEquals(unknownFlags("dispatch", ["t:add", "-abc"]), []);
  assertEquals(unknownFlags("trigger", ["App:in", "type", "-x"]), []);
  assertEquals(unknownFlags("sql", ["-x"]), []);
  // After `--`, nothing is a flag.
  assertEquals(unknownFlags("state", ["--", "-w"]), []);
});

Deno.test("am flags: a positional to a verb that reads none is warned about", () => {
  const w = strayArgsWarning("timeline", ["5"]);
  assert(w !== null && w.includes('"5"') && w.includes("--lines=N"), `${w}`);
  assert(strayArgsWarning("persist", ["counter"]) !== null);
  assert(strayArgsWarning("errors", ["--", "x"]) !== null);
  assertEquals(strayArgsWarning("timeline", []), null);
  assertEquals(strayArgsWarning("timeline", ["--from=j"]), null);
  // Verbs that DO read a positional are not judged here.
  assertEquals(strayArgsWarning("state", ["counter"]), null);
  assertEquals(strayArgsWarning("top", ["2"]), null);
});

Deno.test("am dispatch: an empty --body is refused, not a bare call", () => {
  const { flags } = parseGlobalFlags(["dispatch", "t:add", "--body="]);
  assert(flags.error?.includes("--body needs JSON"), `${flags.error}`);
  const spaced = parseGlobalFlags(["dispatch", "t:add", "--body", ""]);
  assert(spaced.flags.error?.includes("--body needs JSON"));
  assertEquals(
    parseGlobalFlags(["dispatch", "t:add", '--body={"a":1}']).flags.error,
    undefined,
  );
});

Deno.test("am create: a known flag with a space is named, not called unknown", () => {
  const e = assertThrows(
    () => parseCreateArgs(["x", "--template", "counter"]),
    Error,
  );
  assert(e.message.includes("--template takes its value with '='"), e.message);
  assert(!e.message.includes("unknown flag"), e.message);
  const c = assertThrows(() => parseCreateArgs(["x", "--css", "tailwind"]));
  assert((c as Error).message.includes("--css=tailwind"));
});

Deno.test("am top: a bad interval is refused in --json mode too", async () => {
  const port = await freePort();
  const r = await am(["top", "2s", `--port=${port}`, "--app=amtopghost"]);
  assertEquals(r.code, 1, r.out);
  assert(r.out.includes("poll interval"), r.out);
});

Deno.test("am flags: a bare -i is named as needing a value, not unknown", () => {
  for (const argv of [["surface", "-i", "--json"], ["surface", "-i"]]) {
    const { command, args } = parseGlobalFlags(argv);
    const e = unknownFlagError(command, args) ?? "";
    assert(e.includes("-i needs a value"), e);
    assert(!e.includes("did you mean"), e);
  }
  // `-i N` is still consumed as the client index, never refused.
  const { command, args } = parseGlobalFlags(["surface", "-i", "2"]);
  assertEquals(unknownFlagError(command, args), null);
});

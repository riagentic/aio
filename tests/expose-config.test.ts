// `expose` is a CONFIG key, and there is exactly ONE decider for it.
//
// Field report #6, two halves:
//   • A compiled binary run by a service manager has no shell flags, so
//     "this app is a LAN server" had to be expressible in `aio.run({...})`.
//     It was not: `expose` did not exist on CellsConfig, and validateConfig
//     EXITS on an unknown key — so writing it was boot-fatal.
//   • `--expose` forced HTTPS with no way out, even for a payload that is
//     already end-to-end encrypted. The plain-HTTP path existed and was dead.
//
// The trap this file mainly guards is the SECOND DECIDER: `expose` was read
// twice — `cli.expose ?? false` for the transport, and `parseCli().expose` for
// the `visible:"all"` privacy warning. Adding a config key to only the first would
// have bound an app to 0.0.0.0 with the privacy warning silently switched off.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import {
  _exposeOf,
  _resolveAppVersion,
  exposeReason,
} from "../src/server/aio.ts";
import { parseCli } from "../src/server/aio-cli.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo, never into the parent's coverage profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

/** A throwaway app project. `entrySub` nests the entry module (the depth the
 *  version lookup used to fail at); `runOpts` is spliced into aio.run(). */
async function scaffold(opts: {
  appId: string;
  runOpts: string;
  entrySub?: string;
  version?: string;
}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-expose-" });
  const sub = opts.entrySub ?? "src";
  await Deno.mkdir(join(dir, ...sub.split("/")), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: opts.appId,
      ...(opts.version ? { version: opts.version } : {}),
      imports: { aio: join(ROOT, "mod.ts") },
    }),
  );
  await Deno.writeTextFile(
    join(dir, ...sub.split("/"), "app.ts"),
    `import { aio, cell } from "aio";
cell("board", { state: { notes: [] as string[] }, methods: { add(s, t: string) { s.notes.push(t); } } });
await aio.run({ appId: "${opts.appId}", persist: false, singleton: false, client: "server-only", ${opts.runOpts} });
const v = (globalThis as { __aio?: { appVersion?: string } }).__aio;
console.log("PROBE " + JSON.stringify({ version: v?.appVersion ?? null }));
Deno.exit(0);
`,
  );
  return dir;
}

/** Boot the scaffolded app to its first report and collect all its output. */
async function boot(
  dir: string,
  flags: string[],
  entrySub = "src",
): Promise<{ out: string; code: number }> {
  const home = await Deno.makeTempDir({ prefix: "aio-expose-home-" });
  const r = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: home },
    args: ["run", "-A", join(dir, ...entrySub.split("/"), "app.ts"), ...flags],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    out: dec.decode(r.stdout) + dec.decode(r.stderr),
    code: r.code,
  };
}

// ── The decider itself ────────────────────────────────────────────────

Deno.test("expose: ONE decider — CLI wins, config carries, default false", () => {
  assertEquals(_exposeOf({}, {}), false);
  assertEquals(_exposeOf({}, { expose: true }), true, "config alone exposes");
  assertEquals(_exposeOf({ expose: true }, {}), true);
  // The operator running the binary overrides the author's default.
  assertEquals(_exposeOf({ expose: true }, { expose: false }), true);
  // And the same call answers for the privacy warning and the transport —
  // there is no second function to disagree with.
  assertEquals(_exposeOf(parseCli(["--expose"]), {}), true);
  assertEquals(_exposeOf(parseCli([]), { expose: true }), true);
});

Deno.test({
  name:
    'expose: aio.run({ expose: true }) boots (not config-fatal), binds 0.0.0.0 over TLS, AND still warns about ui="all"',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `expose-cfg-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await scaffold({
      appId,
      runOpts: `expose: true, port: ${freePort()}`,
    });
    try {
      const { out, code } = await boot(dir, []);
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      // Pre-fix: validateConfig() exits(1) on the unknown key `expose`.
      assert(
        !out.includes("CONFIG ERROR"),
        `expose must be a valid config key\n${out}`,
      );
      // Really exposed: 0.0.0.0 + wss (TLS is on unless --no-tls).
      assertStringIncludes(out, "wss://0.0.0.0:");
      // THE SECOND-DECIDER TRAP: the privacy warning must fire for an app
      // exposed from config, exactly as it does for --expose.
      assertStringIncludes(out, 'visible="all" on cells: board');
      assertStringIncludes(out, "expose: true");
      // alpha52: exposed with no auth story → a shared key is GENERATED (and
      // the share link carries it) instead of an open port.
      assertStringIncludes(out, "generated a shared app key");
      assertStringIncludes(out, "?token=");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: 'expose: an unexposed app is not warned about ui="all"',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `expose-off-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await scaffold({ appId, runOpts: `port: ${freePort()}` });
    try {
      const { out, code } = await boot(dir, []);
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      assert(
        !out.includes('visible="all" on cells'),
        `warned on loopback\n${out}`,
      );
      // loopback: no key is generated, nothing changes (alpha52 key default
      // is scoped to EXPOSED apps).
      assert(
        !out.includes("generated a shared app key"),
        `loopback must not generate a key\n${out}`,
      );
      assertStringIncludes(out, "ws://localhost:");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── --no-tls ──────────────────────────────────────────────────────────

Deno.test("cli: --no-tls parses, and is off unless asked for", () => {
  assertEquals(parseCli(["--expose", "--no-tls"]).noTls, true);
  assertEquals(parseCli(["--expose"]).noTls, undefined);
  // A parsed flag is a KNOWN flag — an unknown one is only warned about.
  assertEquals(parseCli(["--no-tls"]).noTls, true);
});

Deno.test({
  name: "expose: --expose --no-tls serves plain HTTP and says so loudly",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `expose-plain-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await scaffold({ appId, runOpts: `port: ${freePort()}` });
    try {
      const { out, code } = await boot(dir, ["--expose", "--no-tls"]);
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      // Plain ws:// on 0.0.0.0 — exposed, unencrypted.
      assertStringIncludes(out, "ws://0.0.0.0:");
      assert(!out.includes("wss://"), `TLS must be off\n${out}`);
      // The warning has to name the CONSEQUENCE, not just the setting.
      assertStringIncludes(out, "--no-tls");
      assertStringIncludes(out, "PLAIN HTTP/WS");
      assertStringIncludes(out, "readable");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "expose: --expose alone still forces TLS (no silent downgrade)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `expose-tls-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await scaffold({ appId, runOpts: `port: ${freePort()}` });
    try {
      const { out, code } = await boot(dir, ["--expose"]);
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      assertStringIncludes(out, "wss://0.0.0.0:");
      assert(!out.includes("PLAIN HTTP/WS"), `downgraded silently\n${out}`);
      // The self-signed warning must name NON-browser clients too: naming only
      // browsers is what let the field reporter read a hard CLI-client failure
      // as a cosmetic browser nag.
      assertStringIncludes(out, "non-browser clients");
      assertStringIncludes(out, "am profile");
      assertStringIncludes(out, "DENO_CERT=");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── appVersion honesty ────────────────────────────────────────────────

Deno.test("appVersion: an unknown version says unknown — never a confident 0.0.0", () => {
  const compiled = _resolveAppVersion(undefined, undefined, true);
  assert(
    !compiled.includes("0.0.0"),
    `a compiled binary with no embedded version must not invent one: ${compiled}`,
  );
  assertStringIncludes(compiled, "unknown");
  assertStringIncludes(compiled, "compiled binary");
  assertStringIncludes(compiled, "appVersion", "must say how to fix it");

  const script = _resolveAppVersion(undefined, undefined, false);
  assert(!script.includes("0.0.0"), script);
  assertStringIncludes(script, "unknown");

  // A real version is passed through untouched, from either source.
  assertEquals(_resolveAppVersion("1.2.3", "9.9.9", true), "1.2.3");
  assertEquals(_resolveAppVersion(undefined, "9.9.9", true), "9.9.9");
  assertEquals(_resolveAppVersion("  ", "9.9.9", false), "9.9.9");
});

Deno.test({
  name: "appVersion: a NESTED entry module still finds the app's deno.json",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `ver-nested-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await scaffold({
      appId,
      runOpts: `port: ${freePort()}`,
      entrySub: "src/relay",
      version: "4.5.6",
    });
    try {
      const { out, code } = await boot(dir, [], "src/relay");
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      const line = out.split("\n").find((l) => l.startsWith("PROBE "));
      assert(line, `no probe output\n${out}`);
      // Pre-fix: depth-2 lookup missed `src/relay/../../deno.json` → "0.0.0".
      assertEquals(JSON.parse(line.slice(6)).version, "4.5.6");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "expose: key: false is the explicit opt-out — app stays OPEN, with a loud warning",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `expose-open-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await scaffold({
      appId,
      runOpts: `expose: true, key: false, port: ${freePort()}`,
    });
    try {
      const { out, code } = await boot(dir, []);
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      // No generated key, share link carries no token…
      assert(
        !out.includes("generated a shared app key"),
        `key: false must not generate a key\n${out}`,
      );
      assert(
        !out.includes("?token="),
        `share link must carry no token\n${out}`,
      );
      // …and the openness is said OUT LOUD, not assumed.
      assertStringIncludes(out, "key: false");
      assertStringIncludes(out, "OPEN");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── `host`: the bind address has ONE decider ──────────────────────────
//
// `host` shipped with the same second-decider shape this file exists to guard,
// three ways over: the LISTENER bound `host ?? (expose ? 0.0.0.0 : 127.0.0.1)`,
// the boot report re-derived the address from the FLAG only (so a config-set
// host was reported as `localhost`), and the share/local URLs ignored `host`
// entirely. On a non-loopback bind that is not cosmetic: aio prints — and
// OPENS A CLIENT WINDOW AT — `localhost:PORT`, where nothing is listening.
// `setupTransport` now resolves `bindHost` once and every consumer reads it.

Deno.test({
  name: "host: a config-set bind address reaches the boot report and the URLs",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `host-cfg-${crypto.randomUUID().slice(0, 8)}`;
    const port = freePort();
    // 127.0.0.2 is loopback on Linux and binds without privileges, so the app
    // really listens on an address that is NOT the `localhost` the report used
    // to print — the exact divergence, provable in CI.
    const dir = await scaffold({
      appId,
      runOpts: `host: "127.0.0.2", port: ${port}`,
    });
    try {
      const { out, code } = await boot(dir, []);
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      // The report names where it actually bound…
      assertStringIncludes(out, `ws://127.0.0.2:${port}/ws`);
      assertStringIncludes(out, `http://127.0.0.2:${port}`);
      // …and never advertises an address it is not listening on.
      assert(
        !out.includes(`http://localhost:${port}`),
        `a 127.0.0.2-bound app must not advertise localhost\n${out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "host: the CLI flag wins over config, and the report follows the flag",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `host-flag-${crypto.randomUUID().slice(0, 8)}`;
    const port = freePort();
    const dir = await scaffold({
      appId,
      runOpts: `host: "127.0.0.2", port: ${port}`,
    });
    try {
      const { out, code } = await boot(dir, ["--host=127.0.0.3"]);
      assertEquals(code, 0, `app exited ${code}\n${out}`);
      assertStringIncludes(out, `ws://127.0.0.3:${port}/ws`);
      assert(
        !out.includes("127.0.0.2"),
        `--host must win over config host\n${out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// …and the warnings that fire BECAUSE of it must name what the author wrote.
//
// A message naming the wrong cause costs more time than no message: once a
// non-loopback `host` became a second source of exposure, every "--expose
// with …" line was telling an author about a flag they had never typed. Three
// call sites spelled this for themselves and two were wrong the moment that
// landed. One decider now, and it mirrors `_exposeOf` branch for branch — so
// every input that exposes has a reason, and no input that does not can
// produce one.
Deno.test("exposeReason: every way in is named the way it was written", () => {
  assertEquals(exposeReason({ expose: true }, {}), "--expose");
  assertEquals(exposeReason({}, { expose: true }), "expose: true");
  assertEquals(exposeReason({ host: "0.0.0.0" }, {}), "--host=0.0.0.0");
  assertEquals(exposeReason({}, { host: "0.0.0.0" }), 'host: "0.0.0.0"');
  assertEquals(
    exposeReason({}, { host: "192.168.1.5" }),
    'host: "192.168.1.5"',
  );
  // The flag outranks the config key, exactly as `_exposeOf` reads them.
  assertEquals(
    exposeReason({ expose: true }, { host: "0.0.0.0" }),
    "--expose",
  );
  // A loopback host is not a reason, because it is not exposure.
  assertEquals(_exposeOf({}, { host: "127.0.0.1" }), false);
});

// The pairing, as a property: anything `_exposeOf` calls exposed has a reason
// that names a real input, and the two can never disagree about which.
Deno.test("exposeReason: mirrors _exposeOf on every combination", () => {
  const opts = [undefined, true] as const;
  const hosts = [undefined, "127.0.0.1", "localhost", "0.0.0.0", "10.0.0.4"];
  for (const cliExpose of opts) {
    for (const cfgExpose of opts) {
      for (const cliHost of hosts) {
        for (const cfgHost of hosts) {
          const cli = { expose: cliExpose, host: cliHost };
          const cfg = { expose: cfgExpose, host: cfgHost };
          if (!_exposeOf(cli, cfg)) continue;
          const why = exposeReason(cli, cfg);
          const names = why === "--expose"
            ? cliExpose === true || (!cliExpose && !cfgExpose)
            : why === "expose: true"
            ? cfgExpose === true
            : why.includes(String(cliHost)) || why.includes(String(cfgHost));
          assert(
            names,
            `exposed by ${JSON.stringify({ cli, cfg })} but blamed "${why}"`,
          );
        }
      }
    }
  }
});

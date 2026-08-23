// THE seam gate: an aio app writes inside its own two homes, and nowhere else.
//
// Three findings in one afternoon — a world-readable AppImage unpack in /tmp
// under a predictable name, control sockets at 0755 under the /tmp lock-dir
// fallback, and an appId that changed when you compiled — were all the same
// shape: nobody had asked "what does this process look like from OUTSIDE its
// own directory?". Each was fixed at its own site. This test exists so the
// CLASS cannot come back: it boots a real app with $HOME and $XDG_RUNTIME_DIR
// pointed at a sandbox, then asserts on the filesystem rather than on the code.
//
// The contract, in full:
//   ① every durable path is under `$HOME/.<appId>`
//   ② every ephemeral path is under `$XDG_RUNTIME_DIR/aio`
//   ③ the working directory is NOT a third home (dev used to drop ./data.db there)
//   ④ /tmp gains nothing attributable to us
//   ⑤ secrets are unreachable by other users: 0700 dirs, 0600 files
//
// It runs the app in a CHILD process on purpose — the in-process harness shares
// a filesystem view with the test runner, so it cannot tell our writes from the
// runner's.
import { assert, assertEquals } from "@std/assert";
import { join, relative } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname;
const dec = new TextDecoder();
const APP_ID = "seam-probe";

const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

/** The REAL module cache, resolved before we hand the child a fake $HOME —
 *  otherwise DENO_DIR follows it and Deno re-downloads the whole graph into the
 *  sandbox on every run (slow, and indistinguishable from an aio stray). */
const REAL_DENO_DIR = Deno.env.get("DENO_DIR") ??
  join(Deno.env.get("HOME") ?? "/tmp", ".cache", "deno");

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitFor<T>(fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timeout waiting for the app");
}

/** Every path under `dir`, relative and sorted. Directories included — an empty
 *  directory in the wrong place is still a footprint. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(d)];
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      out.push(relative(dir, p).replaceAll("\\", "/"));
      if (e.isDirectory) rec(p);
    }
  };
  rec(dir);
  return out.sort();
}

function tmpTop(): Set<string> {
  const s = new Set<string>();
  try {
    for (const e of Deno.readDirSync("/tmp")) s.add(e.name);
  } catch { /* no /tmp (windows) */ }
  return s;
}

/** A real app that touches every durable surface we ship: state DB, the
 *  action journal, and a persisted access key. */
const APP_TS = `import { aio, cell } from "aio";
export const probe = cell("probe", {
  state: { n: 0 },
  methods: { inc(s) { s.n++; } },
});
await aio.run({ persist: true, journal: true, key: true });
`;

type Sandbox = {
  root: string;
  home: string;
  run: string;
  proj: string;
  appHome: string;
  projBefore: Set<string>;
  tmpBefore: Set<string>;
};

/** A world with its own $HOME and $XDG_RUNTIME_DIR, holding one real app. */
async function sandbox(): Promise<Sandbox> {
  const root = await Deno.makeTempDir({ prefix: "aio-seam-" });
  const home = join(root, "home");
  const run = join(root, "run");
  const proj = join(root, "proj");
  for (const d of [home, run, join(proj, "src")]) {
    await Deno.mkdir(d, { recursive: true });
  }
  await Deno.writeTextFile(
    join(proj, "deno.json"),
    JSON.stringify({
      title: APP_ID,
      version: "0.0.1",
      unstable: ["kv"],
      imports: {
        "aio": `${ROOT}mod.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
  await Deno.writeTextFile(join(proj, "src", "app.ts"), APP_TS);
  return {
    root,
    home,
    run,
    proj,
    appHome: join(home, `.${APP_ID}`),
    // What the project looked like BEFORE the app ran: anything new here
    // afterwards is a third home the app invented (③).
    projBefore: new Set(walk(proj)),
    tmpBefore: tmpTop(),
  };
}

/** Spawn the app inside a sandbox with its two homes redirected. */
function spawnApp(sb: Sandbox, extraArgs: string[]): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      // The runtime's own artifacts are not the subject: `--no-lock` keeps
      // deno.lock out of the project, and DENO_DIR keeps the module cache out
      // of the sandbox (it would otherwise follow our fake $HOME). Excluding
      // them by CONFIGURATION beats excluding them by allowlist — an allowlist
      // is where a real stray eventually hides.
      "--no-lock",
      "src/app.ts",
      "--client=server-only",
      ...extraArgs,
    ],
    cwd: sb.proj,
    env: {
      DENO_COVERAGE_DIR: _childCovDir,
      DENO_DIR: REAL_DENO_DIR,
      HOME: sb.home,
      USERPROFILE: sb.home,
      XDG_RUNTIME_DIR: sb.run,
      // The DEFAULT rule is what is under test — not the suite-wide override.
      AIO_APPS_DIR: "",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

/** Everything inside the sandbox that is not under one of the app's two homes.
 *  This one list IS the gate. */
function strays(sb: Sandbox): string[] {
  return walk(sb.root).filter((p) => {
    if (p.startsWith(`home/.${APP_ID}`) || p === "home") return false;
    if (p.startsWith("run/aio") || p === "run") return false;
    // `~/.aio/ca` is the third legitimate location, and deliberately NOT inside
    // any one app's home: it is the machine-wide trust root every aio app's
    // certificate is issued from, and the single thing a person installs so
    // their browser stops warning about all of them. Per-app roots would mean a
    // new trust dialog for every app forever. Its MODES are asserted below —
    // permitted here, not unexamined.
    if (p === "home/.aio" || p.startsWith("home/.aio/")) return false;
    if (p === "proj") return false;
    // projBefore is relative to proj/, this walk is relative to root/.
    if (p.startsWith("proj/") && sb.projBefore.has(p.slice("proj/".length))) {
      return false;
    }
    return true;
  });
}

/** New /tmp entries attributable to US. Other processes on a busy box must not
 *  be able to make this test lie in either direction, so everything new is
 *  reported and only ours is failed on. */
function tmpStrays(sb: Sandbox): { ours: string[]; all: string[] } {
  const all = [...tmpTop()].filter((n) => !sb.tmpBefore.has(n));
  // Attribution is about THIS app, not the word "aio": other tests in the same
  // suite make their own `aio-*` temp dirs, and counting those made the gate
  // fail for someone else's tidy, correct behaviour — a gate that cries wolf
  // gets deleted. What must never appear is this app's unpack, socket or lock.
  const ours = all.filter((n) =>
    n.includes(APP_ID) || n.startsWith(".mount_") ||
    n.startsWith("appimage_extracted_")
  );
  return { ours, all };
}

const mode = async (p: string) => (await Deno.stat(p)).mode! & 0o777;

Deno.test({
  name: "seam: an app writes under its two homes and nowhere else",
  ignore: Deno.build.os === "windows", // POSIX modes + $XDG_RUNTIME_DIR
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sb = await sandbox();
    const port = freePort();
    const proc = spawnApp(sb, [`--port=${port}`]);

    let log = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) log += dec.decode(c);
    };
    drain(proc.stdout).catch(() => {});
    drain(proc.stderr).catch(() => {});

    try {
      await waitFor(async () => {
        const r = await fetch(`http://localhost:${port}/__aio/trojan/state`);
        return r.ok ? await r.json() : null;
      });
      // Dispatch for real: a method that persists, journals, and broadcasts.
      const r = await fetch(`http://localhost:${port}/__aio/trojan/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ type: "probe:inc", payload: {} }),
      });
      const body = await r.text(); // read once — the message must not re-read it
      assert(r.ok, `dispatch failed: ${r.status} ${body}`);

      // SIGTERM, not kill: the graceful path is the one that flushes, and a
      // flush that lands in the wrong directory is exactly what this catches.
      proc.kill("SIGTERM");
      await proc.status;

      // ① durable: the app's home exists and holds the state
      assert(
        (await Deno.stat(join(sb.appHome, "data", "state.db"))).isFile,
        `no state.db under ${sb.appHome}/data — where did it go?\n${
          log.slice(-2000)
        }`,
      );

      // ② + ③: everything created inside the sandbox is under one of the two
      // homes. This is the whole gate in one assertion.
      const stray = strays(sb);
      assertEquals(
        stray,
        [],
        `an aio app must write ONLY under ~/.${APP_ID} and ` +
          `$XDG_RUNTIME_DIR/aio — these appeared elsewhere:\n  ${
            stray.join("\n  ")
          }\n${log.slice(-2000)}`,
      );

      const t = tmpStrays(sb);
      assertEquals(
        t.ours,
        [],
        `nothing of ours belongs in shared /tmp. New entries this run: ${
          t.all.join(", ") || "(none)"
        }`,
      );

      // ⑤ modes — the part that makes the location matter. $HOME is 0755 on
      // most distros, so "moved it into the home directory" is not privacy.
      assertEquals(
        await mode(join(sb.appHome, "data")),
        0o700,
        "data/ holds auth.db, the TLS key and app.key — owner-only",
      );
      assertEquals(
        await mode(join(sb.run, "aio")),
        0o700,
        "the runtime dir holds the control socket — owner-only, or any local " +
          "user can connect and dispatch into this app",
      );
      // The journal records action payloads verbatim (passphrases included —
      // see redactActions), so it is a secret file, not a log.
      const journal = join(sb.appHome, "data", "journal");
      assert(
        await Deno.stat(journal).catch(() => null),
        "the journal was never written — the mode assertion below proves nothing",
      );
      assertEquals(await mode(journal), 0o600, "the journal is owner-only");
      // `app.key` and `data/tls` only exist under --expose; the second test
      // covers those.
    } finally {
      try {
        proc.kill();
      } catch { /* already gone */ }
      await proc.status.catch(() => {});
      await Deno.remove(sb.root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "seam: the secrets --expose creates are unreachable by other users",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // `app.key` and the TLS private key only exist on the exposed path — which
    // is precisely the path where the mode matters, because it is the one that
    // assumes a hostile network. Asserted by POLLING the filesystem rather than
    // by talking to the app: TLS moves the control endpoint to a second port,
    // and this test is about files, not transport.
    const sb = await sandbox();
    const port = freePort();
    const proc = spawnApp(sb, ["--expose", `--port=${port}`]);
    let log = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) log += dec.decode(c);
    };
    drain(proc.stdout).catch(() => {});
    drain(proc.stderr).catch(() => {});

    const appKey = join(sb.appHome, "data", "app.key");
    const tlsDir = join(sb.appHome, "data", "tls");
    try {
      await waitFor(async () => {
        const a = await Deno.stat(appKey).catch(() => null);
        const t = await Deno.stat(tlsDir).catch(() => null);
        return a && t ? true : null;
      });
      proc.kill("SIGTERM");
      await proc.status;

      assertEquals(
        await mode(appKey),
        0o600,
        "app.key IS the credential for an exposed app",
      );
      assertEquals(
        await mode(tlsDir),
        0o700,
        "data/tls holds the private key",
      );
      const keyMode = await mode(join(tlsDir, "tls-key.pem"));
      assertEquals(
        keyMode & 0o077,
        0,
        `the TLS private key is reachable by group/other ` +
          `(${keyMode.toString(8)}) — openssl writes with the process umask, ` +
          `so the mode has to be stated where the key is created`,
      );
      // The cert is public by definition; only its existence matters here.
      assert(await Deno.stat(join(tlsDir, "tls-cert.pem")));

      // The machine-wide root. Its private key can mint a trusted certificate
      // for EVERY aio app on this machine for the next ten years, and a person
      // is being asked to put its public half in their browser — which makes it
      // the most sensitive file the framework writes, more than any one app's
      // leaf key. openssl writes with the process umask, so the mode has to be
      // stated where the key is created, and proven here.
      const caDir = join(sb.root, "home", ".aio", "ca");
      assertEquals(await mode(caDir), 0o700, "the root CA dir is owner-only");
      const rootKeyMode = await mode(join(caDir, "aio-root-key.pem"));
      assertEquals(
        rootKeyMode & 0o077,
        0,
        `the aio root key is reachable by group/other ` +
          `(${rootKeyMode.toString(8)})`,
      );

      // Exposing an app must not expose it on the FILESYSTEM either.
      const stray = strays(sb);
      assertEquals(
        stray,
        [],
        `strays under --expose:\n  ${stray.join("\n  ")}\n${log.slice(-2000)}`,
      );
      const t = tmpStrays(sb);
      assertEquals(t.ours, [], `ours in /tmp: ${t.all.join(", ")}`);
    } finally {
      try {
        proc.kill();
      } catch { /* already gone */ }
      await proc.status.catch(() => {});
      await Deno.remove(sb.root, { recursive: true }).catch(() => {});
    }
  },
});

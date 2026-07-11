// Remote-target LAN smoke — exercises the --expose path over a REAL
// non-loopback interface, which localhost tests structurally cannot: binding
// to 0.0.0.0, the auto-generated self-signed TLS cert (whose SANs must cover
// the machine's LAN IPs), the printed share token, and page serving over
// https://<lan-ip>. This is the on-box half of remote validation; a second
// machine is still needed for a true off-box field report (targets stay
// @experimental until then).
//
// Skipped (visibly) when the box has no non-loopback IPv4 or AIO_E2E=0.
import { assert, assertStringIncludes } from "@std/assert";

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo (an empty DENO_COVERAGE_DIR means "cwd"), never into
// the parent's coverage profile.
const _childCovDir = Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

const ROOT = new URL("..", import.meta.url).pathname;

function lanIP(): string | null {
  if (Deno.env.get("AIO_E2E") === "0") return null;
  try {
    return Deno.networkInterfaces()
      .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
      .map((i) => i.address)[0] ?? null;
  } catch {
    return null;
  }
}

const LAN_IP = lanIP();

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

Deno.test({
  name: "e2e: --expose serves over the LAN interface — 0.0.0.0 + TLS + token",
  ignore: LAN_IP === null,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = freePort();
    const dir = `${ROOT}examples/targets/browser-remote`;
    // Regenerate the self-signed cert — a cached one has stale SANs after
    // the machine's LAN IP changes, failing hostname verification.
    await Deno.remove(`${dir}/.aio-tls`, { recursive: true }).catch(() => {});
    const proc = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir },
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "src/app.ts",
        "--client=server-only",
        "--expose",
        `--port=${port}`,
      ],
      cwd: dir,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let client: Deno.HttpClient | null = null;
    try {
      // Watch boot output for the share token — proves token auth is on.
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let token: string | null = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && token === null) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const m = buf.match(/share:\s+\S+\?token=([\w-]+)/);
        if (m) token = m[1]!;
      }
      // Keep draining stdout so the child never blocks on a full pipe.
      (async () => {
        try {
          while (!(await reader.read()).done) { /* drain */ }
        } catch { /* closed */ }
      })();
      assert(token, `no share token in boot output:\n${buf.slice(-2000)}`);

      // Trust the auto-generated self-signed cert — its SANs must include
      // the LAN IP or this fetch fails hostname verification.
      const certPem = await Deno.readTextFile(`${dir}/.aio-tls/tls-cert.pem`);
      client = Deno.createHttpClient({ caCerts: [certPem] });

      // The page must serve over the REAL network interface, not loopback.
      const res = await fetch(
        `https://${LAN_IP}:${port}/?token=${token}`,
        { client } as RequestInit & { client: Deno.HttpClient },
      );
      assert(res.ok, `page over LAN failed: ${res.status}`);
      const html = await res.text();
      assertStringIncludes(html, '<div id="root">');
      assertStringIncludes(html, "importmap");
    } finally {
      client?.close();
      try {
        proc.kill();
      } catch { /* already dead */ }
      await proc.status;
      await proc.stderr.cancel();
    }
  },
});

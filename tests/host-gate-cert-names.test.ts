// The Host gate admits the names in the TLS certificate the app SERVES.
//
// v1.0.10 compat (v1.0.11 hunt): until the gate learned to read HTTP/2's
// `:authority`, every h2 request — every browser on TLS — skipped it, so an
// `--expose` TLS app reached by its own domain (`nas.local`,
// `myapp.example.com`) worked with no `allowedOrigins`. Closing the h2 hole
// turned those apps into a 403. A name in our certificate is one the operator
// already declared as this app's; a rebinding domain cannot be in it. So the
// gate reads the cert's SAN DNS names (a `*.x.y` wildcard covers one label),
// on h2 and HTTP/1.1 alike, and still refuses every other name — with a 403
// that names the exact fix line.
//
// Through the REAL `createServer` over a REAL TLS socket (curl `--resolve`),
// so the test proves the wiring, not just the decider.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import {
  certHostNames,
  certNameCovers,
  hostAllowed,
} from "../src/server/server-auth.ts";
import { generateRoot, issueLeaf } from "../src/server/x509.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const CURL_H2 = await (async () => {
  try {
    const o = await new Deno.Command("curl", { args: ["-V"] }).output();
    return o.success && /\bHTTP2\b/.test(new TextDecoder().decode(o.stdout));
  } catch {
    return false;
  }
})();

/** A leaf naming `dns` — issued in memory, never touching any trust store. */
async function leafFor(dns: string[]): Promise<{ cert: string; key: string }> {
  const root = await generateRoot({
    commonName: "aio-test-root",
    org: "aio test",
    days: 2,
    permittedDns: [".test"],
    permittedIpMasks: [["127.0.0.0", "255.0.0.0"]],
  });
  const leaf = await issueLeaf({
    commonName: "aio-test-leaf",
    dns,
    ips: ["127.0.0.1"],
    days: 2,
    caCertPem: root.certPem,
    caKeyPem: root.keyPem,
  });
  return { cert: leaf.certPem, key: leaf.keyPem };
}

async function curl(
  args: string[],
): Promise<{ status: number; proto: string; body: string }> {
  const o = await new Deno.Command("curl", {
    args: ["-sk", "-m", "20", "-w", "\n%{http_code} %{http_version}", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(o.stdout);
  const nl = out.lastIndexOf("\n");
  const [code, proto] = out.slice(nl + 1).trim().split(" ");
  return { status: Number(code), proto: proto ?? "", body: out.slice(0, nl) };
}

Deno.test({
  name:
    "host gate: a name in the served TLS certificate passes over h2 and HTTP/1.1; any other name is 403 with the fix line",
  ignore: !CURL_H2,
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const dir = await tempDir("aio-host-cert-");
    const { cert, key } = await leafFor(["nas.test", "*.apps.test"]);
    const port = freePort();
    const server = createServer({
      port,
      title: "host-cert",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: true,
      distDir: join(dir, "dist"),
      cert,
      key,
      getHealth: () => ({ status: "healthy" }),
    });
    const h2 = (name: string) =>
      curl([
        "--http2",
        "--resolve",
        `${name}:${port}:127.0.0.1`,
        `https://${name}:${port}/__aio/health`,
      ]);
    const h1 = (name: string) =>
      curl([
        "--http1.1",
        "-H",
        `Host: ${name}:${port}`,
        `https://127.0.0.1:${port}/__aio/health`,
      ]);
    try {
      // The cert's own name, and one label under its wildcard — served.
      for (const name of ["nas.test", "box.apps.test"]) {
        const r2 = await h2(name);
        assertEquals(r2.proto, "2", `${name}: really h2`);
        assertEquals(r2.status, 200, `${name} over h2: ${r2.body}`);
        const r1 = await h1(name);
        assertEquals(r1.proto, "1.1");
        assertEquals(r1.status, 200, `${name} over 1.1: ${r1.body}`);
      }
      // A foreign name, the wildcard's bare base, and two labels deep —
      // refused on both protocols, and the 403 names the exact fix.
      for (const name of ["evil.test", "apps.test", "a.b.apps.test"]) {
        for (const r of [await h2(name), await h1(name)]) {
          assertEquals(r.status, 403, `${name} (${r.proto})`);
          assertStringIncludes(
            r.body,
            `aio.run({ allowedOrigins: ["${name}"] })`,
          );
          assertStringIncludes(r.body, "the names in its TLS certificate");
        }
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test("certNameCovers: exact, or a wildcard over exactly one label; never a bare-TLD wildcard", () => {
  assert(certNameCovers("nas.test", "nas.test"));
  assert(!certNameCovers("nas.test", "x.nas.test"));
  assert(certNameCovers("*.apps.test", "a.apps.test"));
  assert(!certNameCovers("*.apps.test", "apps.test"));
  assert(!certNameCovers("*.apps.test", "a.b.apps.test"));
  assert(!certNameCovers("*.apps.test", ".apps.test"));
  assert(!certNameCovers("*.com", "evil.com"));
  assert(!certNameCovers("*", "evil.com"));
});

Deno.test("certHostNames reads the served cert's SAN DNS names; the gate admits only those", async () => {
  const { cert } = await leafFor(["NAS.test.", "*.apps.test"]);
  const names = certHostNames(cert);
  assertEquals(names, ["nas.test", "*.apps.test"]);
  assertEquals(certHostNames(undefined), []);
  assert(hostAllowed("nas.test:8443", { certNames: names }));
  assert(hostAllowed("x.apps.test", { certNames: names }));
  assert(!hostAllowed("evil.test", { certNames: names }));
  assert(!hostAllowed("nas.test", {}), "no cert, no free pass");
});

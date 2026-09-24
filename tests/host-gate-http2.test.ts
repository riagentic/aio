// remote-desktop field report §3 (v1.0.9-beta): the DNS-rebinding Host gate was OFF
// for every HTTP/2 request. `hostRefusal` read `req.headers.get("host")`, and
// over h2 there is no Host header — the name travels in `:authority`, which
// Deno does not surface as a header but builds `req.url` from. `null` means
// "non-browser client, allow", so any foreign name passed:
//
//   curl -sk --http1.1 -H 'Host: evil.example:P' https://127.0.0.1:P/  → 403
//   curl -sk --resolve evil.example:P:127.0.0.1 https://evil.example:P/ → 200 (h2)
//
// The same `null` made the CSRF gate judge a SAME-origin POST over h2 as
// cross-origin ("no Host header").
//
// A REAL h2 request, not a hand-built Request: the bug lives in what the
// transport hands the handler, which a constructed Request cannot show. The
// client is curl (with `--resolve`, the only way to send a foreign
// `:authority` to 127.0.0.1 without DNS): Deno's own fetch sets `:authority`
// from the URL and drops a user `Host` on h2 (measured), so it cannot send a
// foreign name to a loopback server. `-w %{http_version}` proves the request
// really was h2 — a silent fallback to 1.1 would make the test pass vacuously.

import { assertEquals } from "@std/assert";
import {
  crossOriginRefusal,
  hostRefusal,
  requestHost,
} from "../src/server/server-auth.ts";
import { loadOrCreateCert } from "../src/server/tls.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { pinnedTest } from "../src/testing/env-pin.ts";

// loadOrCreateCert issues from the machine-wide aio root CA; relocate it so
// the test never writes trust material into the developer's real home.
const SANDBOX = await tempDir("aio-h2-host-");
const test = pinnedTest({ AIO_APPS_DIR: SANDBOX });

const CURL_H2 = await (async () => {
  try {
    const o = await new Deno.Command("curl", { args: ["-V"] }).output();
    return o.success && /\bHTTP2\b/.test(new TextDecoder().decode(o.stdout));
  } catch {
    return false;
  }
})();

/** One request through curl; returns status + negotiated HTTP version. */
async function curl(
  args: string[],
): Promise<{ status: number; proto: string }> {
  const o = await new Deno.Command("curl", {
    args: [
      "-sk",
      "-m",
      "20",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code} %{http_version}",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const [code, proto] = new TextDecoder().decode(o.stdout).trim().split(" ");
  return { status: Number(code), proto: proto ?? "" };
}

test({
  name:
    "host gate over real HTTP/2: a foreign :authority is refused (403), an allowlisted one and a same-origin POST pass",
  ignore: !CURL_H2,
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const cert = await loadOrCreateCert(await tempDir("aio-h2-cert-"));
    const allowedOrigins = ["relay.example"];
    const srv = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      cert: cert.cert,
      key: cert.key,
      onListen() {},
    }, (req, info) =>
      hostRefusal(req, info.remoteAddr, { allowedOrigins }) ??
        crossOriginRefusal(req, info.remoteAddr, {
          secure: true,
          allowedOrigins,
          exposed: true,
          authConfigured: true,
          peerLocal: false,
        }) ??
        new Response("ok"));
    const port = srv.addr.port;
    const at = (name: string) => [
      "--resolve",
      `${name}:${port}:127.0.0.1`,
      `https://${name}:${port}/`,
    ];
    try {
      // h2, foreign name → refused. THE regression.
      assertEquals(
        await curl(["--http2", ...at("evil.example")]),
        { status: 403, proto: "2" },
      );
      // h2, allowlisted name → served (the gate reads the name, not "no name").
      assertEquals(
        await curl(["--http2", ...at("relay.example")]),
        { status: 200, proto: "2" },
      );
      // Control: the same refusal over HTTP/1.1, where Host exists.
      assertEquals(
        await curl([
          "--http1.1",
          "-H",
          `Host: evil.example:${port}`,
          `https://127.0.0.1:${port}/`,
        ]),
        { status: 403, proto: "1.1" },
      );
      // h2, same-origin POST with a cookie: the page's own origin must be
      // recognised as the host it reached (it was "no Host header" before).
      // `app.localhost` passes the Host gate by rule and is NOT allowlisted,
      // so only the same-host comparison can admit it.
      assertEquals(
        await curl([
          "--http2",
          "-X",
          "POST",
          "-H",
          `Origin: https://app.localhost:${port}`,
          "-H",
          "Cookie: s=1",
          ...at("app.localhost"),
        ]),
        { status: 200, proto: "2" },
      );
      // ...and a foreign Origin on that same h2 POST is still refused.
      assertEquals(
        await curl([
          "--http2",
          "-X",
          "POST",
          "-H",
          `Origin: https://evil.example:${port}`,
          "-H",
          "Cookie: s=1",
          ...at("app.localhost"),
        ]),
        { status: 403, proto: "2" },
      );
    } finally {
      await srv.shutdown();
    }
  },
});

Deno.test("requestHost: Host header wins; absent (h2), the URL's authority is the name", () => {
  assertEquals(
    requestHost(
      new Request("https://a.example:1/x", {
        headers: { host: "b.example:2" },
      }),
    ),
    "b.example:2",
  );
  assertEquals(
    requestHost(new Request("https://evil.example:8443/x")),
    "evil.example:8443",
  );
});

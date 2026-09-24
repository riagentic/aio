// The auth POST flows' CSRF floor compared a browser's Origin with the Host
// HEADER. An HTTP/2 request has none — the name travels in `:authority`, which
// Deno puts in `req.url` — so over h2 every same-origin login, signup and
// logout POST was refused `cross_origin`. The floor now reads the host the
// same way the DNS-rebinding gate does (`requestHost`).
import { assertEquals } from "@std/assert";
import { type AuthFlows, handleAuthFlow } from "../src/server/auth-flows.ts";

/** An h2-shaped request: the host is in the URL, there is no Host header. */
const h2Post = (origin: string): Request =>
  new Request("https://app.example:8443/__aio/auth/nope", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });

const cfg = { secure: true, cookie: true, signup: false } as AuthFlows;

Deno.test("auth flows over HTTP/2: a same-origin POST is not refused as cross-origin", async () => {
  const req = h2Post("https://app.example:8443");
  assertEquals(req.headers.get("host"), null, "the h2 shape: no Host header");
  const r = await handleAuthFlow(req, new URL(req.url), cfg, undefined);
  const body = await r!.json();
  assertEquals(body.error === "cross_origin", false, JSON.stringify(body));
});

Deno.test("auth flows over HTTP/2: a foreign Origin is still refused", async () => {
  const req = h2Post("https://evil.example");
  const r = await handleAuthFlow(req, new URL(req.url), cfg, undefined);
  assertEquals(r!.status, 403);
  assertEquals((await r!.json()).error, "cross_origin");
});

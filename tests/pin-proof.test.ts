// `/__aio/pin-proof` — the server proves it holds its shared key, for the
// certificate it serves, without the key crossing the wire.
//
// A paired client that finds another certificate at the paired address asks
// this BEFORE it sends the saved key (src/electron/electron-client-script.ts,
// decidePin). The client half is run in
// tests/electron-client-generated-eval.test.ts and, in a real Electron,
// tests/electron-client-strict-pin-e2e.test.ts; this file is the server half.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import {
  answerPinProof,
  pinProofFor,
  pinProofTag,
} from "../src/server/pin-proof.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const NONCE = "ab".repeat(32);
const CERT =
  "-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----\n";

Deno.test("pin proof: only a caller that holds the key is answered, and the answer names the certificate", async () => {
  const tag = await pinProofTag("k", NONCE);
  const ok = await answerPinProof({ nonce: NONCE, tag }, "k", CERT);
  assert(ok.ok);
  assertEquals(ok.cert, CERT);
  assertEquals(ok.proof, await pinProofFor("k", NONCE, CERT));
  // PEM line breaks carry nothing: the client compares with them removed.
  assertEquals(
    ok.proof,
    await pinProofFor("k", NONCE, CERT.replace(/\n/g, "")),
  );
  // Bound to the nonce, the certificate and the key — and not the tag itself.
  assertNotEquals(ok.proof, await pinProofFor("k", "cd".repeat(32), CERT));
  assertNotEquals(ok.proof, await pinProofFor("k", NONCE, CERT + "X"));
  assertNotEquals(ok.proof, await pinProofFor("other", NONCE, CERT));
  assertNotEquals(ok.proof, tag);

  // A caller without the key gets nothing to work on, and is metered.
  for (
    const bad of [
      await pinProofTag("other", NONCE),
      await pinProofTag("k", "cd".repeat(32)),
      "",
      ok.proof, // the server's own answer is not a client tag
    ]
  ) {
    const no = await answerPinProof({ nonce: NONCE, tag: bad }, "k", CERT);
    assertEquals(no, {
      ok: false,
      wrong: true,
      error: "the tag is not this app's key's",
    });
  }
  // A malformed request is the request's fault, not a wrong key.
  for (
    const body of [
      null,
      {},
      { nonce: NONCE },
      { nonce: "zz".repeat(32), tag },
      { nonce: "ab", tag },
      { nonce: NONCE + ":x", tag },
      { nonce: NONCE.toUpperCase(), tag },
      { nonce: NONCE, tag: 1 },
    ]
  ) {
    const no = await answerPinProof(body, "k", CERT);
    assertEquals([no.ok, !no.ok && no.wrong], [false, false], String(body));
  }
});

Deno.test("pin proof: the route answers before the key gate, on the certificate the server serves — and a wrong tag is a metered 401", async () => {
  _resetAuthFails();
  const baseDir = await tempDir("aio-pin-proof-");
  const KEY = "secret-key-123";
  const srv = await testServer({
    appId: `pin-proof-${Deno.pid}`,
    cells: [cell("c_pin_proof", { state: { n: 0 }, methods: {} })],
    expose: true,
    key: KEY,
    baseDir,
  } as never);
  const cert = await Deno.readTextFile(
    join(baseDir, ".aio", "data", "tls", "tls-cert.pem"),
  );
  const client = Deno.createHttpClient({ caCerts: [cert] });
  const ask = async (body: unknown) => {
    const r = await fetch(
      `https://127.0.0.1:${srv.port}/__aio/pin-proof`,
      {
        method: "POST",
        body: JSON.stringify(body),
        client,
      } as RequestInit & { client: Deno.HttpClient },
    );
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch { /* aio-ok: a plain-text refusal (429) */ }
    return { status: r.status, json };
  };
  try {
    // No credential on the request: the caller is deciding whether to send it.
    const ok = await ask({ nonce: NONCE, tag: await pinProofTag(KEY, NONCE) });
    assertEquals(ok.status, 200);
    assertEquals(ok.json.cert, cert, "the file a pairing reply carries");
    assertEquals(ok.json.proof, await pinProofFor(KEY, NONCE, cert));
    assert(!JSON.stringify(ok.json).includes(KEY), "the key crossed the wire");

    assertEquals((await ask({ nonce: "nope", tag: "x" })).status, 400);
    assertEquals((await ask("x".repeat(5000))).status, 413);
    // Wrong tags: 401 each, and they spend the address's failure budget —
    // the same ledger a wrong key and a wrong pairing code spend.
    const wrong = { nonce: NONCE, tag: await pinProofTag("guess", NONCE) };
    let last = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 40 && last !== 429; i++) {
      last = (await ask(wrong)).status;
      seen.add(last);
    }
    assert(seen.has(401), "a wrong tag was answered");
    assertEquals(last, 429, "wrong tags are not metered");
    assertEquals([...seen].sort(), [401, 429]);
  } finally {
    client.close();
    await srv.close();
    _resetAuthFails();
    await dropTempDir(baseDir);
  }
});

Deno.test("pin proof: an app with no shared key has no such route", async () => {
  const srv = await testServer({
    appId: `pin-proof-nokey-${Deno.pid}`,
    cells: [cell("c_pin_proof_nokey", { state: { n: 0 }, methods: {} })],
  } as never);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/__aio/pin-proof`, {
      method: "POST",
      body: JSON.stringify({ nonce: NONCE, tag: "x" }),
    });
    await r.body?.cancel();
    assert(r.status !== 200, "answered without a key to prove");
  } finally {
    await srv.close();
  }
});

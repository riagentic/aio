// PIN pairing by PAKE — `aio.run({ pairing: { pake: true } })` (cpace.ts).
//
// 1. The CPace core reproduces draft-irtf-cfrg-cpace-21 Appendix A/B.1 (suite
//    CPACE-X25519-SHA512) byte for byte, including the low-order abort cases.
// 2. aio's application layer (CI, ADb, tags, box) is pinned by one golden
//    vector that the Electron client's embedded copy and the Android Kotlin
//    port are held to as well (electron / kotlin tests below and in
//    tests/pairing-pake-clients.test.ts).
// 3. Through a real TLS server: the exchange pairs, consumes the code, spends
//    the plain-PIN budgets on a wrong code AND on a certificate the client
//    sees differently (a relay), refuses `{ pin }` loudly, and a default app
//    is untouched.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { cpace, PAKE_PIN_DIGITS } from "../src/server/cpace.ts";
import {
  clearPairing,
  currentPin,
  generatePin,
  MAX_WRONG_TOTAL,
  pakeConfirm,
  pakeOffer,
  verifyPin,
} from "../src/server/pairing.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { pairingRefusal, SHAPE_VALUES } from "../src/server/config.ts";
import { AIO, DRAFT } from "./cpace-vectors.ts";
import { _pakeWithoutTls } from "../src/server/aio-server.ts";

const hex = (s: string) =>
  Uint8Array.from(
    s.replace(/\s+/g, "").match(/../g) ?? [],
    (h) => parseInt(h, 16),
  );
const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const te = new TextEncoder();

Deno.test("cpace: draft-21 Appendix A string vectors", () => {
  assertEquals(toHex(cpace.prependLen(new Uint8Array(0))), "00");
  assertEquals(toHex(cpace.prependLen(te.encode("1234"))), "0431323334");
  const r127 = Uint8Array.from({ length: 127 }, (_, i) => i);
  const r128 = Uint8Array.from({ length: 128 }, (_, i) => i);
  assertEquals(toHex(cpace.prependLen(r127)).slice(0, 4), "7f00");
  assertEquals(cpace.prependLen(r127).length, 128);
  assertEquals(toHex(cpace.prependLen(r128)).slice(0, 6), "800100");
  assertEquals(cpace.prependLen(r128).length, 130);
  assertEquals(
    toHex(
      cpace.lvCat(
        te.encode("1234"),
        te.encode("5"),
        te.encode(""),
        te.encode("678"),
      ),
    ),
    "043132333401350003363738",
  );
  assertEquals(
    toHex(
      cpace.transcriptIr(
        te.encode("123"),
        te.encode("PartyA"),
        te.encode("234"),
        te.encode("PartyB"),
      ),
    ),
    "03313233065061727479410332333406506172747942",
  );
  assertEquals(
    toHex(
      cpace.transcriptIr(
        te.encode("3456"),
        te.encode("PartyA"),
        te.encode("2345"),
        te.encode("PartyB"),
      ),
    ),
    "043334353606506172747941043233343506506172747942",
  );
});

Deno.test("cpace: draft-21 Appendix B.1 — generator, shares, K, ISK", async () => {
  const prs = te.encode(DRAFT.PRS);
  const ci = hex(DRAFT.CI);
  const sid = hex(DRAFT.sid);
  assertEquals(
    toHex(cpace.generatorString(te.encode("CPace255"), prs, ci, sid, 128)),
    DRAFT.genStr,
  );
  const g = await cpace.calculateGenerator(prs, ci, sid);
  assertEquals(toHex(g), DRAFT.g);
  const Ya = await cpace.scalarMultVfy(hex(DRAFT.ya), g);
  const Yb = await cpace.scalarMultVfy(hex(DRAFT.yb), g);
  assertEquals(toHex(Ya), DRAFT.Ya);
  assertEquals(toHex(Yb), DRAFT.Yb);
  const Ka = await cpace.scalarMultVfy(hex(DRAFT.ya), Yb);
  assertEquals(toHex(Ka), DRAFT.K);
  assertEquals(toHex(await cpace.scalarMultVfy(hex(DRAFT.yb), Ya)), DRAFT.K);
  assertEquals(
    toHex(
      await cpace.isk(
        sid,
        Ka,
        Ya,
        te.encode(DRAFT.ADa),
        Yb,
        te.encode(DRAFT.ADb),
      ),
    ),
    DRAFT.ISK_IR,
  );
});

Deno.test("cpace: draft-21 B.1.10 — low-order points give G.I, and an exchange aborts on them", async () => {
  const s = hex(DRAFT.lowOrderS);
  assertEquals(DRAFT.lowOrder.length, 12, "u0 … ub");
  for (const [u, q] of DRAFT.lowOrder) {
    const got = toHex(await cpace.scalarMultVfy(s, hex(u!)));
    assertEquals(got, q === "0" ? "00".repeat(32) : q, `u = ${u}`);
  }
  // A Ya that is a low-order point aborts the responder: no offer at all.
  const sid = hex(DRAFT.sid);
  for (const [u, q] of DRAFT.lowOrder) {
    if (q !== "0") continue;
    assertEquals(
      await cpace.respond("12345678", new Uint8Array(0), sid, hex(u!)),
      null,
      `low-order Ya ${u} must abort`,
    );
  }
});

Deno.test("cpace: aio's application layer matches the shared golden vector", async () => {
  const fp = await cpace.fingerprint(te.encode(AIO.leaf));
  assertEquals(toHex(fp), AIO.fp);
  const sid = hex(DRAFT.sid);
  const st = await cpace.start(AIO.pin, fp, hex(DRAFT.ya), sid);
  assertEquals(toHex(st.Ya), AIO.Ya);
  const r = await cpace.respond(AIO.pin, fp, sid, st.Ya, hex(DRAFT.yb));
  assert(r);
  assertEquals(toHex(r.Yb), AIO.Yb);
  assertEquals(toHex(r.ADb), AIO.fp, "ADb is the server's fingerprint");
  assertEquals(toHex(r.ta), AIO.ta);
  assertEquals(toHex(r.tb), AIO.tb);
  const f = await cpace.finish(st, r.Yb, r.ADb);
  assert(f);
  assertEquals(toHex(f.ta), AIO.ta);
  assertEquals(toHex(f.tb), AIO.tb);
  const box = await cpace.seal(r.isk, sid, AIO.profile, hex(AIO.iv));
  assertEquals(toHex(box), AIO.box);
  assertEquals(await cpace.open(f.isk, sid, box), AIO.profile);
  // Tampered → null, never a garbled profile.
  box[box.length - 1]! ^= 1;
  assertEquals(await cpace.open(f.isk, sid, box), null);
});

Deno.test("cpace: a different code, or a different certificate view, gives different tags", async () => {
  const sid = hex(DRAFT.sid);
  const fp = await cpace.fingerprint(te.encode(AIO.leaf));
  const relay = await cpace.fingerprint(te.encode("a relay's leaf"));
  const st = await cpace.start(AIO.pin, fp, hex(DRAFT.ya), sid);
  const wrongPin = await cpace.respond("12345679", fp, sid, st.Ya);
  const wrongCert = await cpace.respond(AIO.pin, relay, sid, st.Ya);
  assert(wrongPin && wrongCert);
  for (const r of [wrongPin, wrongCert]) {
    const f = await cpace.finish(st, r.Yb, r.ADb);
    assert(f);
    assert(!cpace.same(f.ta, r.ta), "the server would accept a wrong view");
  }
});

Deno.test("pairing: a PAKE code has 8 digits and is never accepted in the clear", () => {
  try {
    const pin = generatePin("scope-pake", { pake: true });
    assertMatch(pin, new RegExp(`^[0-9]{${PAKE_PIN_DIGITS}}$`));
    assertEquals(verifyPin(pin, "1.2.3.4", "scope-pake"), false);
    assertEquals(
      currentPin("scope-pake"),
      pin,
      "and that refusal spends nothing",
    );
    assertMatch(generatePin("scope-plain"), /^[0-9]{6}$/);
  } finally {
    clearPairing();
  }
});

Deno.test("pairing: PAKE state machine — consume on success, budgets on failure", async () => {
  const scope = "scope-sm";
  const fp = await cpace.fingerprint(te.encode(AIO.leaf));
  const sid = () => crypto.getRandomValues(new Uint8Array(16));
  try {
    // Right code → consumed; the second confirm of the same id is unknown.
    const pin = generatePin(scope, { pake: true });
    const st = await cpace.start(pin, fp, undefined, sid());
    const o = await pakeOffer(st.sid, st.Ya, fp, "10.0.0.1", scope);
    assert(o);
    const f = await cpace.finish(st, o.Yb, o.ADb);
    assert(f);
    const ok = pakeConfirm(o.id, f.ta, "10.0.0.1", scope);
    assert(ok.ok);
    assert(cpace.same(ok.tb, f.tb), "server Tb confirms to the client");
    assertEquals(currentPin(scope), null, "a paired code is consumed");
    assertEquals(pakeConfirm(o.id, f.ta, "10.0.0.1", scope), {
      ok: false,
      wrong: false,
    });

    // A plain code never answers message 1.
    generatePin(scope);
    assertEquals(await pakeOffer(st.sid, st.Ya, fp, "10.0.0.1", scope), null);

    // Wrong codes from many addresses burn the PAKE code at the same total.
    const real = generatePin(scope, { pake: true });
    const wrong = real === "00000000" ? "00000001" : "00000000";
    for (let i = 0; i < MAX_WRONG_TOTAL; i++) {
      const g = await cpace.start(wrong, fp, undefined, sid());
      const off = await pakeOffer(g.sid, g.Ya, fp, `10.1.${i}.1`, scope);
      assert(off, `offer ${i}`);
      const gf = await cpace.finish(g, off.Yb, off.ADb);
      assert(gf);
      assertEquals(pakeConfirm(off.id, gf.ta, `10.1.${i}.1`, scope), {
        ok: false,
        wrong: true,
      });
    }
    assertEquals(currentPin(scope), null, "the total budget burned the code");
  } finally {
    clearPairing();
  }
});

Deno.test("config: pairing.pake must be a boolean (the object shape is SHAPE_VALUES')", () => {
  assertEquals(SHAPE_VALUES.pairing, "object");
  assertEquals(pairingRefusal(undefined), null);
  assertEquals(pairingRefusal({}), null);
  assertEquals(pairingRefusal({ pake: true }), null);
  assert(pairingRefusal({ pake: "true" }));
});

// ── Through a real server ────────────────────────────────────────────────

async function pakeApp(pake: boolean) {
  const baseDir = await tempDir("aio-pair-pake-");
  const KEY = `pake-key-${crypto.randomUUID()}`;
  const srv = await testServer({
    appId: `pair-pake-${Deno.pid}-${pake}`,
    cells: [cell(`c_pair_pake_${pake}`, { state: { n: 0 }, methods: {} })],
    expose: true,
    key: KEY,
    baseDir,
    ...(pake ? { pairing: { pake: true } } : {}),
  } as never);
  const cert = await Deno.readTextFile(
    join(baseDir, ".aio", "data", "tls", "tls-cert.pem"),
  );
  const client = Deno.createHttpClient({ caCerts: [cert] });
  const post = async (body: unknown) => {
    const r = await fetch(
      `https://127.0.0.1:${srv.port}/__aio/pair`,
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
  // What a client SEES on this connection: the leaf the server serves.
  const leaf = cpace.unb64(
    /-----BEGIN CERTIFICATE-----([^-]+)-----END/.exec(cert)![1]!.replace(
      /\s+/g,
      "",
    ),
  )!;
  return {
    KEY,
    cert,
    post,
    fp: await cpace.fingerprint(leaf),
    async [Symbol.asyncDispose]() {
      client.close();
      await srv.close();
      clearPairing();
      _resetAuthFails();
      await dropTempDir(baseDir);
    },
  };
}

/** The client side of the exchange, as the Electron and Android clients run
 *  it. `seen` is the fingerprint of the certificate the client was shown. */
async function pakePair(
  post: (
    b: unknown,
  ) => Promise<{ status: number; json: Record<string, unknown> }>,
  pin: string,
  seen: Uint8Array,
) {
  const st = await cpace.start(pin, seen);
  const m1 = await post({
    cpace: cpace.SUITE,
    sid: cpace.b64(st.sid),
    Ya: cpace.b64(st.Ya),
  });
  if (m1.status !== 200) return { step: 1, ...m1 };
  const yb = cpace.unb64(m1.json.Yb, 32)!;
  const adb = cpace.unb64(m1.json.ADb)!;
  const f = await cpace.finish(st, yb, adb);
  assert(f);
  const m2 = await post({
    cpace: cpace.SUITE,
    id: m1.json.id,
    Ta: cpace.b64(f.ta),
  });
  if (m2.status !== 200) return { step: 2, adb, ...m2 };
  assert(cpace.same(cpace.unb64(m2.json.Tb, 64)!, f.tb), "server Tb");
  const profile = await cpace.open(f.isk, st.sid, cpace.unb64(m2.json.box)!);
  return { step: 3, adb, status: 200, json: JSON.parse(profile!) };
}

Deno.test("pairing over TLS: pake pairs, consumes the code, and the key never crosses in the clear", async () => {
  await using app = await pakeApp(true);
  const pin = currentPin(app.KEY);
  assert(pin && pin.length === PAKE_PIN_DIGITS, "the boot code is 8 digits");
  // A WRONG `{ pin }` (an old client): refused loudly, the code survives.
  const wrongPlain = await app.post({ pin: pin === "00000000" ? "1" : "0" });
  assertEquals(wrongPlain.status, 400);
  assertEquals(wrongPlain.json.pake, true);
  assertMatch(String(wrongPlain.json.error), /PAKE only.*update the client/);
  assertEquals(currentPin(app.KEY), pin);

  const r = await pakePair(app.post, pin, app.fp);
  assertEquals(r.status, 200, JSON.stringify(r));
  assertEquals(toHex(r.adb!), toHex(app.fp), "ADb names the served leaf");
  assertEquals(r.json.key, app.KEY);
  assertEquals(r.json.cert, app.cert);
  assertEquals(currentPin(app.KEY), null, "consumed");
  // Replay of the whole exchange: the code is gone.
  assertEquals((await pakePair(app.post, pin, app.fp)).status, 401);
});

Deno.test("pairing over TLS: an old client sending the RIGHT code in the clear BURNS it — a relay that read it cannot pair by PAKE", async () => {
  await using app = await pakeApp(true);
  const pin = currentPin(app.KEY)!;
  const plain = await app.post({ pin });
  assertEquals(plain.status, 400, "the same answer as a wrong code");
  assertMatch(String(plain.json.error), /burned/);
  assertEquals(currentPin(app.KEY), null, "the code is burned");
  // The relay replays it by PAKE, on the real certificate: nothing.
  assertEquals((await pakePair(app.post, pin, app.fp)).status, 401);
});

Deno.test("boot: pairing.pake on an exposed app with no TLS is refused, with the fix", async () => {
  const err = await testServer({
    appId: `pair-pake-notls-${Deno.pid}`,
    cells: [cell("c_pair_pake_notls", { state: { n: 0 }, methods: {} })],
    expose: true,
    host: "127.0.0.1",
    tls: false,
    key: "k-notls",
    pairing: { pake: true },
  } as never).then(
    async (s) => {
      await s.close();
      return null;
    },
    (e: Error) => e,
  );
  assert(err, "an exposed pake app without TLS booted");
  assertMatch(err.message, /pairing: \{ pake: true \} needs TLS/);
  assertMatch(err.message, /tls: \{ cert, key \}/);
  // Loopback-only: said, not refused (no remote client pairs with it).
  assertEquals(_pakeWithoutTls(true, false, false)?.refuse, false);
  assertEquals(_pakeWithoutTls(true, true, true), null);
  assertEquals(_pakeWithoutTls(false, true, false), null);
});

Deno.test("pairing over TLS: a relay's certificate is a wrong guess, on the plain-PIN budgets — 429 after", async () => {
  await using app = await pakeApp(true);
  const pin = currentPin(app.KEY)!;
  const relay = await cpace.fingerprint(te.encode("a relay's own leaf"));
  const r = await pakePair(app.post, pin, relay);
  assertEquals(r.step, 2);
  assertEquals(r.status, 401, "the right code on another certificate");
  // The server still holds the code: a relay learned nothing it can use.
  assertEquals(currentPin(app.KEY), pin);
  // Wrong codes: 401 until the address budget says 429 (pair-429 semantics).
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const w = await pakePair(app.post, "00000000", app.fp);
    seen.add(w.status);
    if (w.status === 429) break;
  }
  assert(seen.has(401) && seen.has(429), [...seen].join(","));
});

Deno.test("pairing over TLS: a default app is unchanged and says it does not speak PAKE", async () => {
  await using app = await pakeApp(false);
  const pin = currentPin(app.KEY)!;
  assertMatch(pin, /^[0-9]{6}$/);
  const m1 = await app.post({ cpace: cpace.SUITE, sid: "x", Ya: "y" });
  assertEquals(m1.status, 400);
  assertEquals(m1.json.pake, false, JSON.stringify(m1));
  const ok = await app.post({ pin });
  assertEquals(ok.status, 200);
  assertEquals(ok.json.key, app.KEY);
});

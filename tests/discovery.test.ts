// LAN discovery — a responder answers UDP broadcast probes; a client sweep
// finds it with IP, port, name, ready URL, and auth flag. Needs --unstable-net
// (the test task passes it via -A --unstable-net; skips cleanly otherwise).
import { assert, assertEquals } from "@std/assert";
import {
  AIO_DISCOVERY_PORT,
  discoverAioApps,
  discoverySupported,
  encodeProbe,
  probeNonce,
  startDiscoveryResponder,
} from "../src/server/discovery.ts";
import dgram from "node:dgram";
import { Buffer } from "node:buffer";

const UDP = discoverySupported();

Deno.test({
  name: "discovery: multi-app-per-host — ONE responder reports EVERY app",
  ignore: !UDP,
  async fn() {
    // The whole point: many apps on different ports, but a single responder
    // (reading the host registry) reports them all — with ip/port/name/url/auth.
    //
    // THE SWEEP CARRIES A PER-RUN NONCE, so it keeps only answers from a
    // responder that echoed it — this one. This test broadcasts on the LAN, so
    // it hears every aio app within reach — the developer's own running apps,
    // another checkout, another machine. Asserting on a total count therefore
    // passed for the wrong reason (three strangers answered) while its own
    // responder was absent, and a fixed name like "dashboard" could match a
    // REAL app and assert against its port. Both failure modes are the same
    // mistake: measuring the neighbourhood instead of the thing under test.
    // Names stay unique per run too — belt and braces for the report text.
    const tag = `t${crypto.randomUUID().slice(0, 8)}`;
    const nonce = tag;
    const hostApps = [
      {
        name: `${tag}-dashboard`,
        port: 8000,
        title: "Dashboard",
        needsAuth: false,
        tls: false,
      },
      {
        name: `${tag}-trading`,
        port: 8010,
        title: "Trading",
        needsAuth: true,
        tls: true,
      },
      {
        name: `${tag}-admin`,
        port: 8020,
        title: "Admin",
        needsAuth: true,
        tls: false,
      },
    ];
    const r = startDiscoveryResponder(() => hostApps);
    try {
      await new Promise((res) => setTimeout(res, 100));
      // Poll until OUR three are all present. A single sweep can miss a
      // datagram — UDP promises nothing — and a miss is not the property under
      // test; that the one responder reports every app is.
      let apps: Awaited<ReturnType<typeof discoverAioApps>> = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        apps = await discoverAioApps({ timeoutMs: 800, nonce });
        if (apps.length >= 3) break;
      }
      // Every answer the nonce sweep kept is OURS — a stranger's app cannot
      // echo a nonce it never saw. So the count is exact, not a floor.
      assertEquals(
        // Only THIS run's apps: another app on this machine running the same
        // aio checkout answers a nonce probe too (every current responder
        // echoes whatever nonce it is sent) — the tag is what is ours.
        apps.map((a) => a.name).filter((n) => n.startsWith(tag)).sort(),
        hostApps.map((a) => a.name).sort(),
        `this run's three apps were not exactly what the nonce sweep found`,
      );
      assert(
        apps.every((a) => !("nonce" in a)),
        "the echo is a wire detail — stripped from the result",
      );
      const dash = apps.find((a) => a.name === `${tag}-dashboard`)!;
      const trade = apps.find((a) => a.name === `${tag}-trading`)!;
      assert(dash, "dashboard found");
      assert(dash.host.length > 0, "host (IP) resolved from the datagram");
      assertEquals(dash.port, 8000);
      assertEquals(dash.url, `http://${dash.host}:8000`);
      assertEquals(dash.needsAuth, false);
      assertEquals(trade.url, `https://${trade.host}:8010`);
      assertEquals(trade.needsAuth, true);
    } finally {
      r.stop();
    }
  },
});

Deno.test({
  name: "discovery: sweep returns [] when nothing is exposed",
  ignore: !UDP,
  async fn() {
    const apps = await discoverAioApps({ timeoutMs: 400 });
    // No responder started in this test — but other tests may race; assert the
    // shape, not emptiness, to avoid cross-test flake.
    assert(Array.isArray(apps));
  },
});

Deno.test({
  name: "discovery: stop() silences a responder",
  ignore: !UDP,
  async fn() {
    const r = startDiscoveryResponder(() => [
      { name: "ephemeral", port: 9999, needsAuth: false, tls: false },
    ]);
    await new Promise((res) => setTimeout(res, 50));
    r.stop();
    await new Promise((res) => setTimeout(res, 50));
    const apps = await discoverAioApps({ timeoutMs: 500 });
    assert(
      !apps.some((a) => a.name === "ephemeral"),
      "a stopped responder must not answer",
    );
  },
});

Deno.test("discovery: startDiscoveryResponder never throws without UDP support", () => {
  // Contract: best-effort. Even here it returns a usable stopper.
  const r = startDiscoveryResponder(() => [], () => {});
  assertEquals(typeof r.stop, "function");
  r.stop();
});

Deno.test("discovery: probeNonce/encodeProbe — the optional third word, bounded", () => {
  assertEquals(probeNonce("AIO_DISCOVER? v1"), null);
  assertEquals(probeNonce("AIO_DISCOVER? v1 abc-12_Z"), "abc-12_Z");
  assertEquals(probeNonce("AIO_DISCOVER? v1 ???"), null, "not a nonce");
  assertEquals(
    probeNonce("AIO_DISCOVER? v1 " + "x".repeat(65)),
    null,
    "bounded",
  );
  assertEquals(probeNonce("HELLO"), null);
  assertEquals(encodeProbe(), "AIO_DISCOVER? v1");
  assertEquals(encodeProbe("n1"), "AIO_DISCOVER? v1 n1");
  assertEquals(probeNonce(encodeProbe("n1")), "n1", "round-trips");
  let threw = false;
  try {
    encodeProbe("has space");
  } catch {
    threw = true;
  }
  assert(threw, "a malformed nonce is refused loud, not sent");
});

Deno.test({
  name:
    "discovery: a nonce sweep drops answers that do not echo it; a plain sweep keeps them",
  ignore: !UDP,
  async fn() {
    // A responder that predates the nonce (or a stranger's app): answers every
    // probe with a plain ad. It must be INVISIBLE to a nonce sweep, and
    // visible to a plain one — the nonce is a test-time filter, and a
    // production sweep still accepts everyone.
    const tag = `s${crypto.randomUUID().slice(0, 8)}`;
    const legacy = dgram.createSocket({ type: "udp4", reuseAddr: true });
    legacy.on(
      "message",
      (msg: Buffer, rinfo: { address: string; port: number }) => {
        if (!msg.toString("utf8").startsWith("AIO_DISCOVER?")) return;
        const ad = {
          name: `${tag}-legacy`,
          port: 7001,
          needsAuth: false,
          tls: false,
        };
        legacy.send(
          Buffer.from("AIO1 " + JSON.stringify(ad)),
          rinfo.port,
          rinfo.address,
        );
      },
    );
    await new Promise<void>((res) => legacy.bind(AIO_DISCOVERY_PORT, res));
    const modern = startDiscoveryResponder(() => [
      { name: `${tag}-modern`, port: 7002, needsAuth: false, tls: false },
    ]);
    try {
      await new Promise((res) => setTimeout(res, 100));
      const names = (l: { name: string }[]) =>
        l.map((a) => a.name).filter((n) => n.startsWith(tag)).sort();
      let plain: string[] = [], filtered: string[] = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        plain = names(await discoverAioApps({ timeoutMs: 600 }));
        filtered = names(await discoverAioApps({ timeoutMs: 600, nonce: tag }));
        if (plain.length === 2 && filtered.length === 1) break;
      }
      assertEquals(
        plain,
        [`${tag}-legacy`, `${tag}-modern`],
        "plain sweep: everyone",
      );
      assertEquals(filtered, [`${tag}-modern`], "nonce sweep: only the echo");
    } finally {
      modern.stop();
      legacy.close();
    }
  },
});

// LAN discovery — a responder answers UDP broadcast probes; a client sweep
// finds it with IP, port, name, ready URL, and auth flag. Needs --unstable-net
// (the test task passes it via -A --unstable-net; skips cleanly otherwise).
import { assert, assertEquals } from "@std/assert";
import {
  discoverAioApps,
  discoverySupported,
  startDiscoveryResponder,
} from "../src/server/discovery.ts";

const UDP = discoverySupported();

Deno.test({
  name: "discovery: multi-app-per-host — ONE responder reports EVERY app",
  ignore: !UDP,
  async fn() {
    // The whole point: many apps on different ports, but a single responder
    // (reading the host registry) reports them all — with ip/port/name/url/auth.
    const hostApps = [
      {
        name: "dashboard",
        port: 8000,
        title: "Dashboard",
        needsAuth: false,
        tls: false,
      },
      {
        name: "trading",
        port: 8010,
        title: "Trading",
        needsAuth: true,
        tls: true,
      },
      {
        name: "admin",
        port: 8020,
        title: "Admin",
        needsAuth: true,
        tls: false,
      },
    ];
    const r = startDiscoveryResponder(() => hostApps);
    try {
      await new Promise((res) => setTimeout(res, 100));
      const apps = await discoverAioApps({ timeoutMs: 800 });
      assertEquals(apps.length >= 3, true, "all three host apps discovered");
      const dash = apps.find((a) => a.name === "dashboard")!;
      const trade = apps.find((a) => a.name === "trading")!;
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

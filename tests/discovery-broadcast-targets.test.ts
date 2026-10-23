// Where a discovery sweep sends its probe.
//
// 255.255.255.255 leaves by ONE interface — the one the routing table gives
// it. Measured on a workstation with a VPN up: that was the VPN, a listener
// on another LAN machine never saw the probe, and `am discover` and the
// client's connect page both said "nothing found" about a network they had
// not asked. Both senders now also probe each interface's own broadcast
// address; this file pins the pure part (interfaces → addresses), that the
// two copies of it agree, and that both senders use it.
import { assert, assertEquals } from "@std/assert";
import dgram from "node:dgram";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { broadcastTargets, discoverAioApps } from "../src/server/discovery.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";

type Iface = { family: string | number; address: string; netmask?: string };
const v4 = (address: string, netmask?: string): Iface => ({
  family: "IPv4",
  address,
  netmask,
});
const LIMITED = "255.255.255.255";

Deno.test("discovery targets: the limited broadcast, then each LAN interface's own broadcast address", () => {
  assertEquals(broadcastTargets([]), [LIMITED]);
  assertEquals(
    broadcastTargets([
      v4("127.0.0.1", "255.0.0.0"), // loopback
      v4("192.168.88.7", "255.255.255.0"),
      v4("10.5.0.2", "255.255.0.0"),
      v4("172.20.3.9", "255.255.252.0"), // /22
      { family: "IPv6", address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::" },
      { family: 4, address: "192.168.1.4", netmask: "255.255.255.128" }, // old Node
    ]),
    [
      LIMITED,
      "192.168.88.255",
      "10.5.255.255",
      "172.20.3.255",
      "192.168.1.127",
    ],
  );
});

Deno.test("discovery targets: no broadcast address is invented for /31, /32, point-to-point or a missing netmask", () => {
  for (
    const i of [
      v4("10.0.0.4", "255.255.255.254"), // /31 — RFC 3021 point-to-point
      v4("10.0.0.5", "255.255.255.255"), // /32 — a tunnel end, a single host
      v4("10.0.0.6"), // no netmask
      v4("10.0.0.7", ""),
      v4("10.0.0.8", "ffff:ff00::"),
      v4("10.0.0.300", "255.255.255.0"),
      v4("not-an-address", "255.255.255.0"),
    ]
  ) {
    assertEquals(broadcastTargets([i]), [LIMITED], JSON.stringify(i));
  }
});

Deno.test("discovery targets: an address is probed once — two interfaces on one subnet, a 0.0.0.0 mask", () => {
  assertEquals(
    broadcastTargets([
      v4("192.168.1.5", "255.255.255.0"), // wifi
      v4("192.168.1.6", "255.255.255.0"), // ethernet, same LAN
      v4("192.168.1.7", "0.0.0.0"), // → 255.255.255.255, already first
    ]),
    [LIMITED, "192.168.1.255"],
  );
});

// ── the client's copy ────────────────────────────────────────────────────

type Send = { to: string; port: number };
/** The generated client main, with `electron` and `dgram` as stand-ins and
 *  `os` reporting `ifaces` (in Node's shape: name → entries). */
function client(
  ifaces: Iface[],
  refuse: (to: string) => boolean = () => false,
) {
  const nodeRequire = createRequire(import.meta.url);
  const sent: Send[] = [];
  const on: Record<string, (...a: unknown[]) => void> = {};
  const errors: string[] = [];
  const noop = () => {};
  const req = (name: string) => {
    if (name === "electron") {
      return {
        app: {
          on: noop,
          getPath: () => "/nonexistent-aio-client-test",
          quit: noop,
          whenReady: () => new Promise(noop),
        },
        BrowserWindow: class {},
        Menu: { setApplicationMenu: noop },
        nativeImage: { createFromBuffer: () => ({}) },
        session: { defaultSession: { setCertificateVerifyProc: noop } },
      };
    }
    if (name === "os") return { networkInterfaces: () => ({ a: ifaces }) };
    if (name === "dgram") {
      return {
        createSocket: () => ({
          on: (n: string, f: (...a: unknown[]) => void) => on[n] = f,
          bind: (f: () => void) => f(),
          setBroadcast: noop,
          close: noop,
          send(
            _p: unknown,
            port: number,
            to: string,
            cb: (e: unknown) => void,
          ) {
            sent.push({ to, port });
            cb(refuse(to) ? new Error("send ENETUNREACH") : null);
          },
        }),
      };
    }
    return nodeRequire("node:" + name);
  };
  const proc = {
    env: {},
    argv: [],
    platform: "linux",
    stdout: { on: noop },
    stderr: { on: noop },
    on: noop,
  };
  const con = {
    log: noop,
    warn: noop,
    // The stub's profile cannot be written: the client says print() falls
    // back (its preload) — true, and not what these tests count.
    error: (...a: unknown[]) => {
      const m = a.map(String).join(" ");
      if (!m.includes("its preload could not be written")) errors.push(m);
    },
  };
  const api = new Function(
    "require",
    "process",
    "console",
    "setInterval",
    electronClientScript(null) + "\nreturn { broadcastTargets, discoverApps };",
  )(req, proc, con, () => 0) as {
    broadcastTargets: (i: Iface[]) => string[];
    discoverApps: (ms: number, cb: (apps: unknown[]) => void) => void;
  };
  const sweep = () => new Promise<unknown[]>((res) => api.discoverApps(5, res));
  return { api, sent, errors, sweep, on };
}

Deno.test("discovery targets: the client's copy and the server's agree on 2000 random interface lists", () => {
  const twin = client([]).api.broadcastTargets;
  // mulberry32 — a failure names its seed.
  let s = 0x5eed;
  const rnd = (n: number) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
  const octet = () => [0, 1, 10, 127, 128, 192, 254, 255, 256, 999][rnd(10)]!;
  const quad = () => `${octet()}.${octet()}.${octet()}.${octet()}`;
  const masks = [
    undefined,
    "",
    "0.0.0.0",
    "255.0.0.0",
    "255.255.0.0",
    "255.255.252.0",
    "255.255.255.0",
    "255.255.255.128",
    "255.255.255.252",
    "255.255.255.254",
    "255.255.255.255",
    "ffff::",
  ];
  const families = ["IPv4", "IPv4", "IPv4", "IPv6", 4, 6];
  const drawn = { skipped: 0, directed: 0, duplicate: 0 };
  for (let n = 0; n < 2000; n++) {
    const list: Iface[] = Array.from({ length: rnd(5) }, () => ({
      family: families[rnd(families.length)]!,
      address: rnd(8) === 0 ? "192.168.1.5" : quad(),
      netmask: masks[rnd(masks.length)],
    }));
    const want = broadcastTargets(list);
    assertEquals(twin(list), want, `list ${n}: ${JSON.stringify(list)}`);
    assertEquals(want[0], LIMITED);
    assertEquals(new Set(want).size, want.length, "an address twice");
    if (want.length > 1) drawn.directed++;
    if (want.length - 1 < list.length) drawn.skipped++;
    const naive = list.filter((i) => i.address === "192.168.1.5").length;
    if (naive > 1) drawn.duplicate++;
  }
  // The seed drew every kind — or the agreement above was about nothing.
  assert(
    drawn.directed > 100 && drawn.skipped > 100 && drawn.duplicate > 20,
    JSON.stringify(drawn),
  );
});

Deno.test("aio-client: a sweep probes every target, and is 'unsent' only when NONE took the probe", async () => {
  const lan = [
    v4("192.168.88.7", "255.255.255.0"),
    v4("10.5.0.2", "255.255.255.255"),
  ];
  const all = client(lan);
  await all.sweep();
  assertEquals(all.sent.map((s) => s.to), [LIMITED, "192.168.88.255"]);
  assertEquals(new Set(all.sent.map((s) => s.port)), new Set([8099]));
  assertEquals(all.errors, []);

  // The measured case: the limited broadcast is refused (or routed into a
  // VPN), the LAN's own address is asked. That sweep asked.
  const vpn = client(lan, (to) => to === LIMITED);
  await vpn.sweep();
  assertEquals(vpn.sent.length, 2);
  assertEquals(vpn.errors, []);

  const none = client(lan, () => true);
  await none.sweep();
  await none.sweep();
  assertEquals(none.sent.length, 4);
  const said = none.errors.filter((l) => l.includes("discovery"));
  assertEquals(said.length, 1, none.errors.join("\n"));
  assert(said[0]!.includes("could not be sent (send ENETUNREACH)"), said[0]);
});

Deno.test("aio-client: an app on THIS machine, answering from each of its addresses, is listed once; another machine's is its own", async () => {
  const c = client([
    v4("192.168.88.7", "255.255.255.0"),
    v4("172.17.0.1", "255.255.0.0"),
  ]);
  const apps = new Promise<{ host: string; port: number }[]>((res) =>
    c.api.discoverApps(20, res as (a: unknown[]) => void)
  );
  const reply = (address: string, port: number) =>
    c.on.message!(
      Buffer.from(
        "AIO1 " +
          JSON.stringify({ name: "notes", port, needsAuth: false, tls: false }),
      ),
      { address, port: 8099 },
    );
  reply("192.168.88.7", 8000);
  reply("172.17.0.1", 8000);
  reply("192.168.88.7", 8001); // a second app here
  reply("192.168.88.9", 8000); // the same app on another machine
  assertEquals(
    (await apps).map((a) => `${a.host}:${a.port}`).sort(),
    ["192.168.88.7:8000", "192.168.88.7:8001", "192.168.88.9:8000"],
  );
});

Deno.test("aio-client: another machine on two subnets this one shares is listed once; two machines are never merged", async () => {
  const c = client([v4("192.168.9.2", "255.255.255.0")]);
  const apps = c.sweep();
  const reply = (address: string, addrs: string[]) =>
    c.on.message!(
      Buffer.from(
        "AIO1 " +
          JSON.stringify({
            name: "x",
            port: 8000,
            needsAuth: false,
            tls: false,
            addrs,
          }),
      ),
      { address, port: 8099 },
    );
  const A = ["192.168.1.5", "10.0.0.5", "172.17.0.1"];
  reply("192.168.1.5", A);
  reply("10.0.0.5", A); // the same machine on the second subnet
  reply("192.168.1.6", ["192.168.1.6", "172.17.0.1"]); // another docker host
  reply("10.0.0.6", ["10.0.0.6", "172.17.0.1"]);
  reply("10.0.0.7", ["10.0.0.7", "192.168.1.5"]); // claims A's address alone
  const got = (await apps) as { host: string }[];
  assertEquals(got.map((a) => a.host), [
    "192.168.1.5",
    "192.168.1.6",
    "10.0.0.6",
    "10.0.0.7",
  ]);
  assert(got.every((a) => !("addrs" in a)), JSON.stringify(got));
});

// One port on two interfaces can be two apps: bound to one address each, a
// machine runs both. The merge (this machine's own addresses, and
// another machine's two subnets) is for ONE app heard twice — never two.
Deno.test("aio-client: two apps on one port of one machine, one per interface, are both listed", async () => {
  const c = client([
    v4("192.168.88.7", "255.255.255.0"),
    v4("172.17.0.1", "255.255.0.0"),
  ]);
  const apps = c.sweep() as Promise<{ host: string; name: string }[]>;
  const reply = (address: string, name: string, addrs?: string[]) =>
    c.on.message!(
      Buffer.from(
        "AIO1 " +
          JSON.stringify({
            name,
            port: 8000,
            needsAuth: false,
            tls: false,
            ...(addrs ? { addrs } : {}),
          }),
      ),
      { address, port: 8099 },
    );
  reply("192.168.88.7", "notes"); // this machine
  reply("172.17.0.1", "wiki");
  const A = ["192.168.1.5", "10.0.0.5"];
  reply("192.168.1.5", "notes", A); // another machine on two shared subnets
  reply("10.0.0.5", "wiki", A);
  assertEquals(
    (await apps).map((a) => `${a.name}@${a.host}`).sort(),
    [
      "notes@192.168.1.5",
      "notes@192.168.88.7",
      "wiki@10.0.0.5",
      "wiki@172.17.0.1",
    ],
  );
});

// ── the server-side sender, on the real network stack ────────────────────

Deno.test("discovery: discoverAioApps sends one probe per target, and lists an app that heard several ONCE", async () => {
  const targets = broadcastTargets(Deno.networkInterfaces());
  const nonce = "t" + crypto.randomUUID().replaceAll("-", "");
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let probes = 0;
  sock.on("message", (msg, rinfo) => {
    if (msg.toString() !== `AIO_DISCOVER? v1 ${nonce}`) return;
    probes++;
    const ad = { name: nonce, port: 7001, needsAuth: false, tls: false, nonce };
    sock.send("AIO1 " + JSON.stringify(ad), rinfo.port, rinfo.address);
  });
  // A port of this test's own: nothing else on the machine answers there.
  const port = await new Promise<number>((res) =>
    sock.bind(0, () => res(sock.address().port))
  );
  try {
    const notes: string[] = [];
    const apps = await discoverAioApps({
      timeoutMs: 600,
      port,
      nonce,
      onNote: (m) => notes.push(m),
    });
    assertEquals(notes, []);
    // A broadcast this machine sends is delivered to its own sockets, so the
    // listener hears the probe once per target that is a real broadcast
    // address here — at least the limited one and, where an interface has a
    // LAN, that LAN's. (A tunnel's "broadcast" address is its far side.)
    assert(
      probes >= Math.min(2, targets.length),
      `${probes} probe(s) heard for ${targets.join(", ")}`,
    );
    // Heard several times, answered several times, each answer from the
    // address of the interface its probe left by: still one app.
    assertEquals(apps.map((a) => a.name), [nonce]);
  } finally {
    await new Promise<void>((res) => sock.close(() => res()));
  }
});

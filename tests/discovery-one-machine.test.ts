// One machine heard from two addresses is ONE entry; two machines never are.
//
// A remote host on two subnets the prober shares answers each subnet's probe
// from that subnet's address — `am discover` and the aio client listed every
// one of its apps twice. Each reply now carries the answering machine's own
// addresses (`addrs`), and two replies for one port merge only when each one's
// source is among the other's addresses (`oneMachine`).
import { assert, assertEquals } from "@std/assert";
import dgram from "node:dgram";
import { Buffer } from "node:buffer";
import {
  discoverAioApps,
  oneMachine,
  probeNonce,
} from "../src/server/discovery.ts";

Deno.test("discovery oneMachine: both sources named by the other — never one side, a shared off-segment address, or itself", () => {
  const r = (host: string, addrs?: string[]) => ({ host, addrs });
  const A = ["192.168.1.5", "10.0.0.5", "172.17.0.1"];
  assert(oneMachine(r("192.168.1.5", A), r("10.0.0.5", A)));
  // Two docker hosts share 172.17.0.1 — never the source each answered from.
  const B = ["192.168.1.6", "10.0.0.6", "172.17.0.1"];
  assert(!oneMachine(r("192.168.1.5", A), r("192.168.1.6", B)));
  assert(!oneMachine(r("192.168.1.5", A), r("10.0.0.6", B)));
  // One side only: a reply claiming another's address does not hide it.
  assert(!oneMachine(r("192.168.1.5", A), r("10.0.0.5", ["10.0.0.5"])));
  assert(!oneMachine(r("192.168.1.5", ["192.168.1.6"]), r("192.168.1.6", B)));
  // An older responder sends no list: keyed by address, as before.
  assert(!oneMachine(r("192.168.1.5"), r("10.0.0.5")));
  assert(!oneMachine(r("192.168.1.5", A), r("10.0.0.5")));
  assert(!oneMachine(r("192.168.1.5", A), r("192.168.1.5", A)));
});

/** A fake remote machine: hears the probe on a port of its own, answers from each of
 *  `from` (one socket per source address) with `addrs` as its own list. */
async function fakeMachine(
  apps: { name: string; port: number }[],
  from: string[],
  addrs: (src: string) => string[] | undefined,
  answers: (src: string, app: { name: string }) => boolean = () => true,
) {
  const senders = await Promise.all(
    from.map((a) =>
      new Promise<dgram.Socket>((res) => {
        const s = dgram.createSocket("udp4");
        s.bind(0, a, () => res(s));
      })
    ),
  );
  const ear = dgram.createSocket({ type: "udp4", reuseAddr: true });
  ear.on("message", (msg, rinfo) => {
    const nonce = probeNonce(msg.toString("utf8"));
    senders.forEach((s, k) => {
      for (const app of apps) {
        if (!answers(from[k]!, app)) continue;
        const list = addrs(from[k]!);
        const ad = {
          ...app,
          needsAuth: false,
          tls: false,
          nonce,
          ...(list ? { addrs: list } : {}),
        };
        s.send(
          Buffer.from("AIO1 " + JSON.stringify(ad)),
          rinfo.port,
          "127.0.0.1",
        );
      }
    });
  });
  // A port of this test's own: nothing else on the machine answers there.
  const port = await new Promise<number>((res) =>
    ear.bind(0, () => res(ear.address().port))
  );
  return { port, stop: () => [ear, ...senders].forEach((s) => s.close()) };
}

// 127.0.0.2 answers only on Linux, where all of 127/8 is this host's; it is
// not in the interface list, so to the sweep it is a remote address.
const LINUX = Deno.build.os === "linux";

for (
  const [what, addrs, want] of [
    ["one machine on two shared subnets is listed once", () => [
      "127.0.0.2",
      "127.0.0.3",
    ], 1],
    [
      "two machines that only share an address off the segment are both listed",
      (
        src: string,
      ) => [src, "172.17.0.1"],
      2,
    ],
    [
      "a responder without the list is keyed by address, as before",
      () => undefined,
      2,
    ],
  ] as const
) {
  Deno.test({
    name: `discovery sweep: ${what}`,
    ignore: !LINUX,
    async fn() {
      const nonce = `m${crypto.randomUUID().slice(0, 8)}`;
      const { port, stop } = await fakeMachine(
        [{ name: `${nonce}-a`, port: 8000 }, {
          name: `${nonce}-b`,
          port: 8010,
        }],
        ["127.0.0.2", "127.0.0.3"],
        addrs,
      );
      try {
        const apps = await discoverAioApps({ timeoutMs: 400, port, nonce });
        assertEquals(
          apps.filter((a) => a.port === 8000).length,
          want,
          JSON.stringify(apps),
        );
        assertEquals(apps.filter((a) => a.port === 8010).length, want);
        // The list is how replies are matched, not part of what is reported.
        assert(apps.every((a) => !("addrs" in a)), JSON.stringify(apps));
      } finally {
        stop();
      }
    },
  });
}

// One port on two interfaces can be two apps (each bound to one address): the
// merge is for one app heard twice, so it asks the name too.
Deno.test({
  name:
    "discovery sweep: two apps on one port of one machine, one per interface, are both listed",
  ignore: !LINUX,
  async fn() {
    const nonce = `m${crypto.randomUUID().slice(0, 8)}`;
    const { port, stop } = await fakeMachine(
      [{ name: `${nonce}-a`, port: 8000 }, { name: `${nonce}-b`, port: 8000 }],
      ["127.0.0.2", "127.0.0.3"],
      () => ["127.0.0.2", "127.0.0.3"],
      (src, app) => app.name.endsWith(src === "127.0.0.2" ? "-a" : "-b"),
    );
    try {
      const apps = await discoverAioApps({ timeoutMs: 400, port, nonce });
      assertEquals(
        apps.map((a) => `${a.name}@${a.host}`),
        [`${nonce}-a@127.0.0.2`, `${nonce}-b@127.0.0.3`],
      );
    } finally {
      stop();
    }
  },
});

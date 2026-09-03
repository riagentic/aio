// The boot report's SECURITY POSTURE lines must describe the address that was
// actually bound.
//
// Three lines are about it — `bind`, the `--expose` warning, and the share
// link — and all three used to be derived from the `expose` BOOLEAN, which
// only implied an address. So:
//
//   --host=192.168.88.151        → "bind 0.0.0.0 — every interface"
//                                  (ss showed one interface)
//   --expose --host=127.0.0.1    → "every interface", "expose true", and a
//                                  share link no other device could open
//   host: "127.0.0.2" in config  → "bind 127.0.0.1 — loopback only"
//
// An operator reads that line to decide whether the app is on the network.
// Two of those three answers were the opposite of the truth, and the comment
// above the derivation claimed it read the bound address.
//
// `bindHost` (setupTransport's one resolved answer) is now the input to all
// three, and the wording is pure — so each shape is a unit test, plus a real
// boot to prove the wiring carries it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  bindLabel,
  firstLanIPv4,
  isLoopbackBind,
  shareLink,
} from "../src/server/aio-lifecycle.ts";
import { freePort } from "../src/testing/server-test.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const _childCovDir = childCoverageDir();

// ── The wording ───────────────────────────────────────────────────────

Deno.test("bindLabel: the address, and what binding it MEANS", () => {
  assertEquals(bindLabel("0.0.0.0"), "0.0.0.0 — every interface");
  assertEquals(bindLabel("::"), ":: — every interface");
  assertEquals(bindLabel("127.0.0.1"), "127.0.0.1 — loopback only");
  // The bug in miniature: a second loopback address is loopback, and is NOT
  // 127.0.0.1 — the line used to print the wrong address with the right word.
  assertEquals(bindLabel("127.0.0.2"), "127.0.0.2 — loopback only");
  assertEquals(bindLabel("::1"), "::1 — loopback only");
  // …and one chosen interface is neither of the two stories that existed.
  assertEquals(
    bindLabel("192.168.88.151"),
    "192.168.88.151 — that interface only",
  );
});

Deno.test("isLoopbackBind: every spelling of 'this machine only'", () => {
  for (const h of ["127.0.0.1", "127.0.0.2", "127.1.2.3", "::1", "[::1]"]) {
    assert(isLoopbackBind(h), h);
  }
  for (const h of ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5"]) {
    assert(!isLoopbackBind(h), h);
  }
});

Deno.test("shareLink: a wildcard bind is not an address anyone can open", () => {
  // Nobody can open https://0.0.0.0:8443 — the LAN address stands in.
  assertEquals(
    shareLink("https://0.0.0.0:8443", "0.0.0.0", "192.168.1.20"),
    { url: "https://192.168.1.20:8443", note: "" },
  );
  // …and when the machine's addresses are unknown (no --allow-sys), the link
  // says in words what to substitute rather than lying by omission.
  const blind = shareLink("https://0.0.0.0:8443", "0.0.0.0", undefined);
  assertEquals(blind.url, "https://0.0.0.0:8443");
  assertStringIncludes(blind.note, "LAN IP");
});

Deno.test("shareLink: a loopback bind says it opens nowhere else", () => {
  const s = shareLink("https://localhost:8443", "127.0.0.1", "192.168.1.20");
  assertEquals(s.url, "https://localhost:8443", "the URL is left alone");
  assertStringIncludes(s.note, "loopback only");
});

Deno.test("shareLink: a chosen interface is quoted as itself, no note", () => {
  assertEquals(
    shareLink("https://192.168.1.20:8443", "192.168.1.20", "192.168.1.20"),
    { url: "https://192.168.1.20:8443", note: "" },
  );
});

Deno.test("firstLanIPv4: the first non-loopback IPv4, or nothing", () => {
  assertEquals(
    firstLanIPv4([
      { family: "IPv4", address: "127.0.0.1" },
      { family: "IPv6", address: "fe80::1" },
      { family: "IPv4", address: "192.168.1.20" },
      { family: "IPv4", address: "10.0.0.5" },
    ]),
    "192.168.1.20",
  );
  assertEquals(
    firstLanIPv4([{ family: "IPv4", address: "127.0.0.1" }]),
    undefined,
  );
  assertEquals(firstLanIPv4([]), undefined);
});

// ── The wiring: a real boot prints the real address ───────────────────

async function scaffold(appId: string, runOpts = ""): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-bind-" });
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ title: appId, imports: { aio: join(ROOT, "mod.ts") } }),
  );
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { aio, cell } from "aio";
cell("board", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: "${appId}", persist: false, singleton: false, client: "server-only"${
      runOpts ? ", " + runOpts : ""
    } });
Deno.exit(0);
`,
  );
  return dir;
}

async function boot(
  dir: string,
  flags: string[],
): Promise<{ out: string; code: number }> {
  const home = await tempDir("aio-bind-home-");
  const r = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: home },
    args: ["run", "-A", join(dir, "src", "app.ts"), ...flags],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { out: dec.decode(r.stdout) + dec.decode(r.stderr), code: r.code };
}

Deno.test({
  name: "boot report: --host=127.0.0.2 reports 127.0.0.2, not 127.0.0.1",
  async fn() {
    const dir = await scaffold(`bind-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        "--host=127.0.0.2",
        `--port=${freePort()}`,
      ]);
      assertEquals(code, 0, out);
      assertStringIncludes(out, "127.0.0.2 — loopback only");
      assert(
        !out.includes("127.0.0.1 — loopback only"),
        `the bind line named an address the listener is not on\n${out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "boot report: --expose --host=127.0.0.1 does not claim the network — and the share link is openable",
  async fn() {
    const dir = await scaffold(`bind-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        "--expose",
        "--host=127.0.0.1",
        `--port=${freePort()}`,
      ]);
      assertEquals(code, 0, out);
      assertStringIncludes(out, "127.0.0.1 — loopback only");
      assert(
        !out.includes("0.0.0.0 — every interface"),
        `an exposed-but-loopback app claimed every interface\n${out}`,
      );
      // Both halves of the ask, not just the flag.
      assertStringIncludes(out, "expose");
      assertStringIncludes(out, "loopback bind");
      // The warning stops inviting the LAN in.
      assert(
        !out.includes("reachable by anyone on this network"),
        `loopback bind warned about the network\n${out}`,
      );
      // And no share link points at an address nobody can open.
      assert(
        !out.includes("https://0.0.0.0:") && !out.includes("http://0.0.0.0:"),
        `share link on a wildcard address\n${out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "boot report: --expose (wildcard) shares an address another device can open",
  async fn() {
    const dir = await scaffold(`bind-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        "--expose",
        `--port=${freePort()}`,
      ]);
      assertEquals(code, 0, out);
      assertStringIncludes(out, "0.0.0.0 — every interface");
      const share = out.split("\n").find((l) => l.includes("share:")) ?? "";
      assert(share.length > 0, `no share line\n${out}`);
      // Either the LAN address is substituted, or the line says in words that
      // it must be — never a bare https://0.0.0.0 with no explanation.
      assert(
        !share.includes("//0.0.0.0:") || share.includes("LAN IP"),
        `share link nobody can open, with no note: ${share}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "boot report: a chosen LAN interface is reported as that interface",
  ignore: firstLanIPv4(Deno.networkInterfaces()) === undefined,
  async fn() {
    const ip = firstLanIPv4(Deno.networkInterfaces())!;
    const dir = await scaffold(`bind-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        `--host=${ip}`,
        `--port=${freePort()}`,
      ]);
      assertEquals(code, 0, out);
      assertStringIncludes(out, `${ip} — that interface only`);
      assert(
        !out.includes("0.0.0.0 — every interface"),
        `one interface reported as every interface\n${out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── A flag that cannot act says so ────────────────────────────────────

Deno.test({
  name:
    "boot report: --channel with no updates config says the flag does nothing",
  async fn() {
    const dir = await scaffold(`bind-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        "--channel=bogus",
        `--port=${freePort()}`,
      ]);
      // WARNED, not refused: `updates: prod ? {…} : undefined` is a real
      // shape, and a dev run of that app is not a mistake.
      assertEquals(code, 0, out);
      assertStringIncludes(out, "--channel=bogus does nothing here");
      assertStringIncludes(out, "updates");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "boot report: no --channel, no warning",
  async fn() {
    const dir = await scaffold(`bind-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [`--port=${freePort()}`]);
      assertEquals(code, 0, out);
      assert(!out.includes("does nothing here"), out);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

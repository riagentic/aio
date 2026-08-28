// `--cdp` / AIO_CDP: opt-in DevTools Protocol for the Electron window.
// (a) flag + env parsing, one decider; (b) the launch passes the Chromium
// switch ONLY when asked — a bound debugging port is a port.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  _resetParsedCli,
  cdpPort,
  parseCdp,
  parseCli,
} from "../src/server/aio-cli.ts";
import { cdpSwitches, launchElectron } from "../src/electron/electron-spawn.ts";

Deno.test("parseCli: --cdp is true, --cdp=N is N, a bad N is refused", () => {
  assertEquals(parseCli(["--cdp"]).cdp, true);
  assertEquals(parseCli(["--cdp=9222"]).cdp, 9222);
  assertEquals(parseCli([]).cdp, undefined);
  // Not "ignored": an operator who typed a port meant to open one, and
  // silently opening none is the behaviour they will debug for an hour.
  assertThrows(() => parseCli(["--cdp=abc"]), Error, "--cdp=abc");
  assertThrows(() => parseCli(["--cdp=70000"]), Error, "--cdp=70000");
});

Deno.test("parseCdp: flag beats env; AIO_CDP=1|port|0|garbage", () => {
  assertEquals(parseCdp(9222, "1"), 9222);
  assertEquals(parseCdp(undefined, "1"), true);
  assertEquals(parseCdp(undefined, "true"), true);
  assertEquals(parseCdp(undefined, "9333"), 9333);
  assertEquals(parseCdp(undefined, "0"), undefined);
  assertEquals(parseCdp(undefined, ""), undefined);
  assertEquals(parseCdp(undefined, undefined), undefined);
  assertEquals(parseCdp(undefined, "nope"), undefined);
});

Deno.test("cdpPort(): undefined unless asked; AIO_CDP=1 picks ONE free port per process", () => {
  const prev = Deno.env.get("AIO_CDP");
  try {
    Deno.env.delete("AIO_CDP");
    _resetParsedCli();
    assertEquals(cdpPort(), undefined);
    Deno.env.set("AIO_CDP", "1");
    _resetParsedCli();
    const a = cdpPort();
    assert(a !== undefined && a >= 49152 && a < 65536, `free port: ${a}`);
    assertEquals(cdpPort(), a); // memoized — lock, boot line, launch agree
    Deno.env.set("AIO_CDP", "9444");
    _resetParsedCli();
    assertEquals(cdpPort(), 9444);
  } finally {
    _resetParsedCli();
    if (prev === undefined) Deno.env.delete("AIO_CDP");
    else Deno.env.set("AIO_CDP", prev);
  }
});

Deno.test("cdpSwitches: the switch exists only when a port does", () => {
  assertEquals(cdpSwitches(undefined), []);
  assertEquals(cdpSwitches(0), []);
  assertEquals(cdpSwitches(9222), ["--remote-debugging-port=9222"]);
});

// A fake Electron ($ELECTRON_PATH rung) that records its argv: the real
// launch path, the real spawn, the real switch — no display needed.
Deno.test({
  name:
    "launchElectron passes --remote-debugging-port only when cdpPort is set",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const argv = `${dir}/argv.txt`;
    const bin = `${dir}/fake-electron`;
    await Deno.writeTextFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argv}\nexit 0\n`,
    );
    await Deno.chmod(bin, 0o755);
    const prev = Deno.env.get("ELECTRON_PATH");
    Deno.env.set("ELECTRON_PATH", bin);
    const log = { info() {}, error() {}, warn() {}, debug() {} };
    try {
      const run = async (port?: number) => {
        const p = await launchElectron(
          "http://localhost:1/",
          log,
          undefined,
          undefined,
          undefined,
          port,
        );
        assert(p, "spawned");
        await p.status;
        return (await Deno.readTextFile(argv)).split("\n").filter(Boolean);
      };
      const without = await run(undefined);
      assert(
        !without.some((a) => a.includes("remote-debugging")),
        `no switch by default: ${without}`,
      );
      const withPort = await run(9555);
      assert(
        withPort.includes("--remote-debugging-port=9555"),
        `switch present: ${withPort}`,
      );
    } finally {
      if (prev === undefined) Deno.env.delete("ELECTRON_PATH");
      else Deno.env.set("ELECTRON_PATH", prev);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

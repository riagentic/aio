// Only `setChannel` pins a channel (docs/deploy/updates.md, "Channels").
//
// Boot used to save whatever the FIRST boot resolved — the config literal, the
// "prod" default, a git source's "main" — and that copy then outranked the
// config for good: `channel: "test"` → boot → `channel: "dev"` did nothing,
// and an app moved from a git source to a manifest one asked
// `<source>/main/<os>-<arch>.json` for ever.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUpdates } from "../src/server/updates-boot.ts";
import { readTrust } from "../src/server/updates-check.ts";
import {
  installUpdatesRuntime,
  updatesRuntime,
} from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function recorder(): Log & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (...a: unknown[]) => {
    lines.push(`${level} ${a.map(String).join(" ")}`);
  };
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
  } as unknown as Log & { lines: string[] };
}

const SOURCE = "https://example.invalid/rel";

function boot(data: string, channel?: string, log = recorder()) {
  const started = startUpdates({
    updates: { source: SOURCE, check: false, channel },
    dataDir: data,
    appName: "demo",
    appVersion: "1.0.0",
    local: { schema: 1, cells: {} },
    exposed: false,
    log,
    argv: [],
  });
  started.stop();
  return { channel: started.channel, log };
}

async function withData(fn: (data: string) => Promise<void>) {
  const data = await tempDir("aio-channel-pin-");
  try {
    await fn(data);
  } finally {
    installUpdatesRuntime(null);
    await dropTempDir(data);
  }
}

Deno.test("channel: a later config change takes effect — boot pins nothing", () =>
  withData(async (data) => {
    assertEquals(boot(data, "test").channel, "test");
    assertEquals(readTrust(data).channel, undefined);
    assertEquals(boot(data, "dev").channel, "dev");
    await Promise.resolve();
  }));

Deno.test("channel: a setChannel choice persists, is marked, and outranks config", () =>
  withData(async (data) => {
    boot(data, "test");
    // The runtime boot installed — what the app's `updates.setChannel` calls.
    await updatesRuntime()!.setChannel("beta");
    const t = readTrust(data);
    assertEquals([t.channel, t.channelBy], ["beta", "setChannel"]);
    const again = boot(data, "dev");
    assertEquals(again.channel, "beta");
    assert(
      !again.log.lines.some((l) => l.startsWith("warn")),
      `a choice is followed without a word: ${again.log.lines.join(" | ")}`,
    );
  }));

Deno.test("channel: a legacy saved value that changes nothing is dropped", () =>
  withData(async (data) => {
    // What an older aio wrote at first boot: no origin.
    await Deno.writeTextFile(
      join(data, "update-trust.json"),
      JSON.stringify({ channel: "test" }),
    );
    const first = boot(data, "test");
    assertEquals(first.channel, "test");
    assertEquals(readTrust(data).channel, undefined, "dropped: same answer");
    assert(!first.log.lines.some((l) => l.startsWith("warn")));
    // …so the config change that follows it is honoured.
    assertEquals(boot(data, "dev").channel, "dev");
  }));

Deno.test("channel: a legacy value that DIFFERS is kept, and said with both ways out", () =>
  withData(async (data) => {
    // An app that once followed a git source, now on a manifest source:
    // the git default "main" was saved at its first boot.
    await Deno.writeTextFile(
      join(data, "update-trust.json"),
      JSON.stringify({ channel: "main" }),
    );
    const { channel, log } = boot(data);
    // Kept: it may be an operator's setChannel() — never moved silently.
    assertEquals(channel, "main");
    assertEquals(readTrust(data).channel, "main");
    const warn = log.lines.find((l) => l.startsWith("warn")) ?? "";
    assertStringIncludes(warn, 'following channel "main"');
    assertStringIncludes(warn, '("prod")');
    assertStringIncludes(warn, `${SOURCE}/main/`);
    assertStringIncludes(warn, 'remove "channel"');
    assertStringIncludes(warn, 'updates.setChannel("main")');
  }));

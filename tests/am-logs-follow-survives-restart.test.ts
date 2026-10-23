// `am logs --follow` across a restart. A boot rotates the log by RENAME
// (app.log → app.log.1) and writes a fresh file; a watch on the FILE followed
// the old inode, so `am logs -f` showed the stop and then nothing, forever.
import "./store-sandbox.ts";
import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const AM = fromFileUrl(new URL("../src/am.ts", import.meta.url));

Deno.test("am logs --follow keeps streaming after the log is rotated by rename", async () => {
  const dir = await tempDir("am-follow-");
  const home = join(dir, "home");
  const logs = join(home, "logs");
  await Deno.mkdir(logs, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ title: "followapp" }),
  );
  const log = join(logs, "stdout.log");
  const line = (msg: string) =>
    `2026-10-22 00:00:00.000+02:00  INFO   app         ${msg}\n`;
  await Deno.writeTextFile(log, line("first boot"));

  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AM, "logs", "--follow", `--home=${home}`, "--lines=1"],
    cwd: dir,
    stdout: "piped",
    stderr: "null",
    env: { NO_COLOR: "1" },
  }).spawn();
  let seen = "";
  const reader = (async () => {
    const dec = new TextDecoder();
    for await (const c of child.stdout) seen += dec.decode(c, { stream: true });
  })();
  const waitFor = async (s: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!seen.includes(s) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return seen.includes(s);
  };
  try {
    assert(await waitFor("first boot"), `tail missing: ${seen}`);
    await Deno.writeTextFile(log, line("stopping"), { append: true });
    assert(await waitFor("stopping"), `live line missing: ${seen}`);
    // What a restart does: rename the live file away, then boot writes anew.
    await Deno.rename(log, `${log}.1`);
    await Deno.writeTextFile(log, line("second boot"));
    assert(
      await waitFor("second boot"),
      `am logs --follow went silent after the log was rotated: ${seen}`,
    );
  } finally {
    child.kill("SIGTERM");
    await child.status;
    await reader.catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});

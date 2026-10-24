// `am logs --follow` with a multi-line event split across two writes: the
// header arrives in one read, its stack in the next. Grouped per read, the
// stack was a headless event — and a headless event passes every filter, so
// `--level=warn` streamed the stack of an INFO line.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { followEvents, logEventMatches } from "../src/am/am-cmd-inspect.ts";

const AM = fromFileUrl(new URL("../src/am.ts", import.meta.url));
const at = (lvl: string) => `2026-10-22 00:00:00.000+02:00  ${lvl}  app  `;

Deno.test("followEvents: a continuation is judged with the event it continues", () => {
  const warn = (e: readonly string[]) => logEventMatches(e, { level: "warn" });
  let r = followEvents(null, [at("INFO") + "quiet"], warn);
  assertEquals(r.out, []);
  r = followEvents(r.carry, ["    at frame-info", ""], warn);
  assertEquals(r.out, [], "an INFO event's stack passed --level=warn");
  r = followEvents(r.carry, [at("WARN") + "loud"], warn);
  r = followEvents(r.carry, ["    at frame-warn"], warn);
  assertEquals(r.out, ["    at frame-warn"], "printed lines repeat");
  // A substring filter the continuation satisfies prints the event whole.
  const word = (e: readonly string[]) => e.join("\n").includes("needle");
  r = followEvents(null, [at("INFO") + "head"], word);
  assertEquals(r.out, []);
  r = followEvents(r.carry, ["    at needle"], word);
  assertEquals(r.out, [at("INFO") + "head", "    at needle"]);
});

Deno.test("am logs --follow --level=warn drops an INFO event's split stack", async () => {
  const dir = await tempDir("am-follow-split-");
  const logs = join(dir, "home", "logs");
  await Deno.mkdir(logs, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ title: "followsplit" }),
  );
  const log = join(logs, "stdout.log");
  await Deno.writeTextFile(log, at("WARN") + "first\n");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      AM,
      "logs",
      "--follow",
      "--level=warn",
      `--home=${join(dir, "home")}`,
      "--lines=1",
    ],
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
  const append = async (s: string) => {
    await Deno.writeTextFile(log, s, { append: true });
    // Let the watcher read this write on its own.
    await new Promise((r) => setTimeout(r, 1_200));
  };
  try {
    assert(await waitFor("first"), `tail missing: ${seen}`);
    await append(at("INFO") + "quiet\n");
    await append("    at frame-info\n");
    await append(at("WARN") + "loud\n");
    await append("    at frame-warn\n");
    assert(await waitFor("frame-warn"), `live stack missing: ${seen}`);
    assert(!seen.includes("frame-info"), `INFO stack leaked: ${seen}`);
    assert(!seen.includes("quiet"), seen);
  } finally {
    child.kill("SIGTERM");
    await child.status;
    await reader.catch(() => {});
    await dropTempDir(dir);
  }
});

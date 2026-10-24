// `am logs --follow` with a multibyte UTF-8 char split across two reads (a
// writer flushing mid-char, or a 64 KB read edge). A fresh TextDecoder per
// read turned each half into U+FFFD, so "café" streamed as "caf��".
import "./store-sandbox.ts";
import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = fromFileUrl(new URL("../src/am.ts", import.meta.url));

Deno.test("am logs --follow decodes a UTF-8 char split across two reads", async () => {
  const dir = await tempDir("am-follow-utf8-");
  const logs = join(dir, "home", "logs");
  await Deno.mkdir(logs, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ title: "followutf8" }),
  );
  const log = join(logs, "stdout.log");
  const head = "2026-10-22 00:00:00.000+02:00  INFO   app         ";
  await Deno.writeTextFile(log, head + "first\n");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      AM,
      "logs",
      "--follow",
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
  const append = (b: Uint8Array) => Deno.writeFile(log, b, { append: true });
  try {
    assert(await waitFor("first"), `tail missing: ${seen}`);
    const bytes = new TextEncoder().encode(head + "café split\n");
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    await append(bytes.subarray(0, cut));
    // Let the watcher read the first half on its own.
    await new Promise((r) => setTimeout(r, 1_500));
    await append(bytes.subarray(cut));
    assert(await waitFor("split"), `live line missing: ${seen}`);
    assert(seen.includes("café split"), `garbled: ${JSON.stringify(seen)}`);
  } finally {
    child.kill("SIGTERM");
    await child.status;
    await reader.catch(() => {});
    await dropTempDir(dir);
  }
});

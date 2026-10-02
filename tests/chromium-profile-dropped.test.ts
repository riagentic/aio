// A test browser's profile is gone when its owner is done with it — on
// close(), and when the process exits without close().
//
// The helpers were looked up by matching NUL-split /proc cmdline arguments,
// but Chromium rewrites its process title into ONE space-joined string: the
// lookup found nothing, nothing was killed, and a network service still
// flushing on its way out created the removed profile again
// (`Default/Cache`, `Default/Cookies`). The exit path only sent SIGTERM.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  _holdsProfile,
  chromiumPage,
  launchChromium,
} from "../src/testing/chromium.ts";
import { findChromium } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CHROME = findChromium();
const gated = { ignore: !CHROME || Deno.build.os !== "linux" };

Deno.test("chromium: a profile flag is found in a space-joined (retitled) cmdline", () => {
  const p = "/t/aio-test-browser-ab";
  assert(_holdsProfile(`chromium --type=renderer --user-data-dir=${p} --x`, p));
  assert(_holdsProfile(`chromium\0--user-data-dir=${p}\0--x\0`, p));
  assert(_holdsProfile(`chromium --user-data-dir=${p}`, p));
  assert(!_holdsProfile(`chromium --user-data-dir=${p}c --x`, p));
  assert(!_holdsProfile(`chromium --user-data-dir=${p}/sub`, p));
  assert(!_holdsProfile(`chromium --x`, p));
});

/** Pids whose cmdline mentions `profile` at all. */
function mentioning(profile: string): number[] {
  const out: number[] = [];
  for (const e of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      if (Deno.readTextFileSync(`/proc/${e.name}/cmdline`).includes(profile)) {
        out.push(Number(e.name));
      }
    } catch {
      // aio-ok: the process ended between the listing and the read
    }
  }
  return out;
}

const exists = (p: string) =>
  Deno.stat(p).then(() => true, (e) => {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  });

Deno.test({
  ...gated,
  name:
    "chromium: close() leaves no helper running on the profile, and no profile",
  async fn() {
    const b = await launchChromium(CHROME!, [
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    const cdp = await chromiumPage(b);
    await cdp.call("Page.navigate", { url: "data:text/html,hi" });
    await cdp.close();
    await b.close();
    assertEquals(mentioning(b.profile), [], "helpers outlived close()");
    assert(!(await exists(b.profile)), "the profile is still there");
  },
});

Deno.test({
  ...gated,
  name:
    "chromium: a process that exits without close() takes its browser and profile with it",
  async fn() {
    const dir = await tempDir("aio-chromium-exit-");
    try {
      const fixture = `${dir}/exit.ts`;
      const src = new URL("../src/testing/chromium.ts", import.meta.url).href;
      await Deno.writeTextFile(
        fixture,
        `import { chromiumPage, launchChromium } from ${JSON.stringify(src)};
const b = await launchChromium(${
          JSON.stringify(CHROME)
        }, ["--remote-debugging-port=0", "about:blank"]);
const cdp = await chromiumPage(b);
await cdp.call("Page.navigate", { url: "data:text/html,hi" });
console.log("PROFILE=" + b.profile);
Deno.exit(0);
`,
      );
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-lock",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          fixture,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
      const profile = /PROFILE=(\S+)/.exec(text)?.[1];
      assert(profile, text);
      assertEquals(mentioning(profile), [], "helpers outlived the process");
      assert(!(await exists(profile)), "the profile outlived the process");
    } finally {
      await dropTempDir(dir);
    }
  },
});

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
  _profilePidsIn,
  chromiumPage,
  dropBrowserProfile,
  launchChromium,
} from "../src/testing/chromium.ts";
import { findChromium } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { processList } from "./proc-helper.ts";

const CHROME = findChromium();
// The helpers are found through /proc on Linux, `ps` on macOS and the process
// table on Windows — on each, none may outlive the browser.
const gated = { ignore: !CHROME };

Deno.test("chromium: a profile flag is found in a space-joined (retitled) cmdline", () => {
  const p = "/t/aio-test-browser-ab";
  assert(_holdsProfile(`chromium --type=renderer --user-data-dir=${p} --x`, p));
  assert(_holdsProfile(`chromium\0--user-data-dir=${p}\0--x\0`, p));
  assert(_holdsProfile(`chromium --user-data-dir=${p}`, p));
  assert(!_holdsProfile(`chromium --user-data-dir=${p}c --x`, p));
  assert(!_holdsProfile(`chromium --user-data-dir=${p}/sub`, p));
  assert(!_holdsProfile(`chromium --x`, p));
});

/** Pids whose command line mentions `profile` at all. */
async function mentioning(profile: string): Promise<number[]> {
  return (await processList()).filter((p) =>
    p.pid !== Deno.pid && p.cmd.includes(profile) &&
    // the listing's own process (Windows: the PowerShell query) names nothing
    !/Get-CimInstance|ps -axo/.test(p.cmd)
  ).map((p) => p.pid);
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
    assertEquals(await mentioning(b.profile), [], "helpers outlived close()");
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
      // The exit ENDS them; a killed process is in the listing until the
      // kernel has taken it apart, and on a loaded machine (load 20, a full
      // release check) two were still listed in the instant after the exit.
      // Ten seconds for that — helpers that were never ended are still there.
      let left = await mentioning(profile);
      for (let i = 0; i < 100 && left.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        left = await mentioning(profile);
      }
      assertEquals(left, [], "helpers outlived the process");
      assert(!(await exists(profile)), "the profile outlived the process");
    } finally {
      await dropTempDir(dir);
    }
  },
});

// No browser needed: any process started on a profile is one of its helpers.
// Off Linux `profileProcesses` answered [] — nothing was ever found, so
// nothing was ended, and the profile directory stayed (busy, on Windows).
Deno.test("chromium: a helper still running on the profile is found and ended on THIS OS, then the profile goes", async () => {
  const profile = await tempDir("aio-test-browser-");
  const helper = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "setTimeout(() => {}, 120000)",
      `--user-data-dir=${profile}`,
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    // It is in the process table before the product is asked to look.
    const deadline = Date.now() + 20_000;
    while (!(await mentioning(profile)).includes(helper.pid)) {
      assert(Date.now() < deadline, "the stand-in helper never appeared");
      await new Promise((r) => setTimeout(r, 50));
    }
    await dropBrowserProfile(profile);
    const st = await helper.status;
    assert(!st.success, "the helper was not ended");
    assertEquals(await mentioning(profile), []);
    assert(!(await exists(profile)), "the profile is still there");
  } finally {
    try {
      helper.kill("SIGKILL");
    } catch { /* aio-ok: ended by the product, as asserted */ }
    await helper.status;
    await dropTempDir(profile);
  }
});

Deno.test("chromium: a listing line is matched whatever the OS quotes", () => {
  const p = "C:\\Users\\me\\AppData\\Local\\Temp\\aio-test-browser-ab";
  const listing = [
    `  412 "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --type=renderer "--user-data-dir=${p}" --x`,
    `  413 msedge.exe --user-data-dir=${p} --y`,
    `  414 msedge.exe --user-data-dir=${p}c`,
    `  415 `,
    `garbage`,
    // Chromium's own children on Windows: the VALUE is quoted.
    `  416 msedge.exe --type=gpu-process --user-data-dir="${p}" --z`,
    `  417 msedge.exe --type=gpu-process --user-data-dir="${p}c" --z`,
  ].join("\r\n");
  assertEquals(_profilePidsIn(listing, p), [412, 413, 416]);
});

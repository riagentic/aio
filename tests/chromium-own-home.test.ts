// A test browser can be kept out of the developer's HOME, fonts included.
//
// `--user-data-dir` does not hold everything: on Linux a Chromium rewrites
// `~/.config/chromium/Crash Reports/settings.dat` on every launch and opens
// `~/.pki/nssdb` read-write (measured, `strace`, Chromium 153). A new HOME
// moves both and loses the user's fonts, so `AIO_TEST_BROWSER_HOME=own` gives
// the browser a HOME inside its throwaway profile AND a fontconfig file that
// still names the real user's font directories. Opt-in: without it a test
// browser runs as it always has.
import { assert, assertEquals } from "@std/assert";
import {
  _ownHomeEnv,
  chromiumPage,
  launchChromium,
} from "../src/testing/chromium.ts";
import { findChromium } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { aioTestRoot } from "../src/testing/test-strict.ts";

const CHROME = findChromium();
const linux = Deno.build.os === "linux";

/** Every path under `dir`, relative, sorted. */
async function tree(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(`${dir}/${rel}`)) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    out.push(p);
    if (e.isDirectory) out.push(...await tree(dir, p));
  }
  return out.sort();
}

/** Launch one page with HOME = `home` and return what the launch left there
 *  and what it put in the profile's own home. */
async function launchIn(
  home: string,
  own: boolean,
): Promise<{ left: string[]; ownHome: string[] }> {
  const before = { HOME: Deno.env.get("HOME") };
  const names = [
    "AIO_TEST_ROOT",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "AIO_TEST_BROWSER_HOME",
  ];
  const saved = names.map((n) => [n, Deno.env.get(n)] as const);
  // The harness's own scratch root follows HOME: it stays where it is.
  const root = aioTestRoot();
  Deno.env.set("HOME", home);
  for (const n of names) Deno.env.delete(n);
  Deno.env.set("AIO_TEST_ROOT", root);
  if (own) Deno.env.set("AIO_TEST_BROWSER_HOME", "own");
  try {
    const b = await launchChromium(CHROME!, [
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    let ownHome: string[] = [];
    try {
      const cdp = await chromiumPage(b);
      await cdp.call("Page.navigate", { url: "data:text/html,hi" });
      await cdp.close();
      if (own) ownHome = await tree(`${b.profile}/aio-home`);
    } finally {
      await b.close();
    }
    return { left: await tree(home), ownHome };
  } finally {
    Deno.env.set("HOME", before.HOME!);
    for (const [n, v] of saved) {
      if (v === undefined) Deno.env.delete(n);
      else Deno.env.set(n, v);
    }
  }
}

Deno.test({
  ignore: !CHROME || !linux,
  name:
    "chromium: with AIO_TEST_BROWSER_HOME=own a launch writes nothing under HOME, and without it it does",
  async fn() {
    const home = await tempDir("aio-chromium-home-");
    try {
      const own = await launchIn(home, true);
      assertEquals(own.left, [], "the browser wrote under HOME");
      assert(
        own.ownHome.includes(".config/chromium/Crash Reports/settings.dat"),
        `the crash database is not in the profile's home: ${own.ownHome}`,
      );
      // The control: the SAME launch without the option is what writes there
      // — or the empty list above proves nothing about this Chromium.
      const plain = await launchIn(home, false);
      assert(
        plain.left.includes(".config/chromium/Crash Reports/settings.dat"),
        `a plain launch left no crash database under HOME: ${plain.left}`,
      );
    } finally {
      await dropTempDir(home);
    }
  },
});

/** A font file of this machine, or null. */
async function anyFont(dir = "/usr/share/fonts"): Promise<string | null> {
  try {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        const f = await anyFont(p);
        if (f) return f;
      } else if (/\.(ttf|otf)$/i.test(e.name)) return p;
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return null;
}

const fcList = (env: Record<string, string>) =>
  new Deno.Command("fc-list", { clearEnv: true, env, stdout: "piped" })
    .output().then((o) => new TextDecoder().decode(o.stdout));

const hasFcList = linux && await new Deno.Command("fc-list", {
  args: ["--version"],
  stdout: "null",
  stderr: "null",
}).output().then((o) => o.success, () => false);
const FONT = hasFcList ? await anyFont() : null;

Deno.test({
  ignore: !FONT,
  name:
    "chromium: the browser's own HOME still finds the real user's fonts, and a bare new HOME does not",
  async fn() {
    const root = await tempDir("aio-chromium-fonts-");
    try {
      const real = `${root}/real`, home = `${root}/own`;
      // One font the user installed in each place fontconfig looks.
      const xdg = `${real}/.local/share/fonts/aio-xdg.ttf`;
      const dot = `${real}/.fonts/aio-dot.ttf`;
      await Deno.mkdir(`${real}/.local/share/fonts`, { recursive: true });
      await Deno.mkdir(`${real}/.fonts`);
      await Deno.mkdir(home);
      await Deno.copyFile(FONT!, xdg);
      await Deno.copyFile(FONT!, dot);

      const own = _ownHomeEnv(home, { HOME: real });
      await Deno.writeTextFile(`${home}/fonts.conf`, own.fontsConf);
      const PATH = Deno.env.get("PATH") ?? "";
      const seen = await fcList({ PATH, ...own.env });
      assert(seen.includes(xdg), `the XDG font is not listed:\n${seen}`);
      assert(seen.includes(dot), `the ~/.fonts font is not listed`);
      // …and nothing was written beside them: the cache went to `home`.
      assertEquals(await tree(real), [
        ".fonts",
        ".fonts/aio-dot.ttf",
        ".local",
        ".local/share",
        ".local/share/fonts",
        ".local/share/fonts/aio-xdg.ttf",
      ]);
      // The control: a new HOME without the file loses both.
      const bare = await fcList({ PATH, HOME: home });
      assert(!bare.includes(xdg) && !bare.includes(dot), bare);
    } finally {
      await dropTempDir(root);
    }
  },
});

Deno.test("chromium: the own-HOME env keeps a FONTCONFIG_FILE and XAUTHORITY already in force", () => {
  const set = _ownHomeEnv("/t/h", {
    HOME: "/home/u",
    XDG_CONFIG_HOME: "/cfg",
    XDG_DATA_HOME: "/data",
    FONTCONFIG_FILE: "/my/fonts&.conf",
    XAUTHORITY: "/run/x",
  });
  assert(!("XAUTHORITY" in set.env), "an explicit cookie path was replaced");
  assert(set.fontsConf.includes(">/my/fonts&amp;.conf</include>"));
  assert(set.fontsConf.includes(">/cfg/fontconfig/fonts.conf</include>"));
  assert(set.fontsConf.includes("<dir>/data/fonts</dir>"));
  assertEquals(
    _ownHomeEnv("/t/h", { HOME: "/home/u" }).env.XAUTHORITY,
    "/home/u/.Xauthority",
  );
});

// The launcher is one door; a test that starts its browser by hand is
// another, and each of those rewrote the real crash database too.
Deno.test("tests: a file that starts a browser on a profile of its own gives it browserHomeEnv()", async () => {
  const dir = new URL(".", import.meta.url);
  const bare: string[] = [];
  let starters = 0;
  for await (const e of Deno.readDir(dir)) {
    if (!/\.tsx?$/.test(e.name)) continue;
    const src = await Deno.readTextFile(new URL(e.name, dir));
    // The flag as an argument of its own — not a command line a test quotes
    // — of a browser (a stand-in process given the flag is headless nowhere).
    if (
      !/`--user-data-dir=\$\{[^}]+\}`/.test(src) || !/--headless/.test(src)
    ) continue;
    starters++;
    if (!/\bbrowserHomeEnv\(/.test(src)) bare.push(e.name);
  }
  assert(starters >= 10, `only ${starters} such files were found`);
  assertEquals(
    bare,
    [],
    "spread `...browserHomeEnv(profile)` (src/testing/chromium.ts) into the " +
      "spawn's env, before `...testDisplayEnv()`",
  );
});

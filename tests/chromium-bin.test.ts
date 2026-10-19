// An EXPLICIT browser — `{ browserPath }` or `$CHROMIUM_BIN` — that does not
// exist is refused at the call, by name. It used to be returned unchecked, so
// `testBrowser` rejected LATER with a raw "Failed to spawn" (its comment says
// "throws at the call"), and `testUI --video` rendered the whole test before
// failing at dispose with an OS error that named neither the variable nor
// the fix.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DELIMITER } from "@std/path";
import { EXE } from "./fake-program-helper.ts";
import {
  _chromiumCandidates,
  _launchFlags,
  chromiumBin,
  findChromium,
} from "../src/testing/chromium.ts";
import { testBrowser } from "../src/testing/server-test.ts";
import { dropTempDir, tempDirSync } from "../src/testing/temp-dir.ts";

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prior = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    return fn();
  } finally {
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  }
}

Deno.test("testBrowser: a missing browserPath throws synchronously, naming it", () => {
  assertThrows(
    () =>
      void testBrowser("http://127.0.0.1:1/", {
        browserPath: "/nonexistent/chrome",
      }),
    Error,
    "[testBrowser] no headless Chromium/Chrome at /nonexistent/chrome",
  );
});

Deno.test("chromiumBin: a missing $CHROMIUM_BIN is named, before anything runs", () => {
  withEnv(
    "CHROME_BIN",
    undefined,
    () =>
      withEnv("CHROMIUM_BIN", "/nonexistent/chromium", () => {
        assertThrows(
          () => chromiumBin("[aio:video] testUI --video"),
          Error,
          "$CHROMIUM_BIN=/nonexistent/chromium does not exist",
        );
      }),
  );
});

Deno.test("chromiumBin: a bare command name is looked up on PATH, not stat'ed in the cwd", async () => {
  const dir = tempDirSync("aio-chromium-bin-");
  try {
    const exe = `${dir}/fake-chromium${EXE}`;
    Deno.writeTextFileSync(exe, "#!/bin/sh\n");
    Deno.chmodSync(exe, 0o755);
    withEnv("PATH", `${dir}${DELIMITER}${Deno.env.get("PATH") ?? ""}`, () => {
      assertEquals(chromiumBin("x", "fake-chromium"), "fake-chromium");
      assertThrows(
        () => chromiumBin("x", "no-such-chromium-anywhere"),
        Error,
        "not found on PATH",
      );
    });
  } finally {
    await dropTempDir(dir);
  }
});

// `findChromium` probed five paths, none of them on Windows — where Edge ships
// with the OS — so every real-browser helper there answered "no headless
// Chromium/Chrome found" on a machine that had one.
Deno.test("findChromium: Windows is probed under all three install roots, Edge included", () => {
  const env: Record<string, string> = {
    "ProgramFiles": "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    "LOCALAPPDATA": "C:\\Users\\me\\AppData\\Local",
  };
  const c = _chromiumCandidates("windows", (n) => env[n]);
  for (const root of Object.values(env)) {
    for (
      const rel of [
        "Google\\Chrome\\Application\\chrome.exe",
        "Microsoft\\Edge\\Application\\msedge.exe",
      ]
    ) {
      assertEquals(c.includes(`${root}\\${rel}`), true, `${root}\\${rel}`);
    }
  }
  // An unset root contributes nothing — never a path that starts at `undefined`.
  assertEquals(
    _chromiumCandidates("windows", () => undefined),
    [],
  );
});

Deno.test("findChromium: macOS and Linux also know Edge, Chromium and Brave", () => {
  const mac = _chromiumCandidates("darwin");
  assertEquals(
    mac.includes(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    true,
  );
  assertEquals(
    mac.includes(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ),
    true,
  );
  const linux = _chromiumCandidates("linux");
  // The paths every earlier release probed, in the same order, first.
  assertEquals(linux.slice(0, 4), [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]);
  assertEquals(linux.includes("/usr/bin/microsoft-edge"), true);
});

Deno.test("findChromium: $CHROMIUM_BIN still wins over every probed path", () => {
  withEnv("CHROMIUM_BIN", "/chosen/by/hand", () => {
    assertEquals(findChromium(), "/chosen/by/hand");
  });
});

// Found on Windows, Edge must also be launched the way that does not cost the
// user a failed logon per launch (ten of them lock the Windows account).
Deno.test("launchChromium: Windows launches a guest window; other hosts launch what they always did", () => {
  assertEquals(_launchFlags("P", "windows")[0], "--guest");
  const posix = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--password-store=basic",
    "--use-mock-keychain",
    "--user-data-dir=P",
  ];
  assertEquals(_launchFlags("P", "linux"), posix);
  assertEquals(_launchFlags("P", "darwin"), posix);
  assertEquals(_launchFlags("P", "windows").slice(2), posix);
});

// From an elevated shell a Chromium relaunches itself un-elevated and the
// spawned process exits 0 — every test browser failed, and the relaunch ran
// on as an orphan (measured on Windows 11, Edge 155).
Deno.test("launchChromium: Windows keeps an elevated launch the process aio spawned", () => {
  assertEquals(_launchFlags("P", "windows")[1], "--do-not-de-elevate");
  assertEquals(
    _launchFlags("P", "linux").includes("--do-not-de-elevate"),
    false,
  );
});

// ONE launcher: the guest flag above protects a Windows user only if no other
// product code starts a browser on a profile of its own.
Deno.test("launchChromium is the only place in src/ that starts a browser", async () => {
  const hits: string[] = [];
  let files = 0;
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        files++;
        const text = await Deno.readTextFile(p);
        if (/["'`]--headless=|["'`]--user-data-dir=/.test(text)) hits.push(p);
      }
    }
  };
  const src = new URL("../src", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  await walk(src);
  assertEquals(files > 300, true, "src/ was not walked");
  assertEquals(
    hits.map((h) => h.slice(src.length + 1)).sort(),
    ["testing/chromium.ts"],
  );
  // …and inside that file the launch takes its flags from `_launchFlags`:
  // a second, hand-written flag list there would be a launch with no guest.
  const own = await Deno.readTextFile(`${src}/testing/chromium.ts`);
  assertEquals(own.split('"--headless=').length - 1, 1);
  assert(own.includes("args: [..._launchFlags(profile), ...args]"));
});

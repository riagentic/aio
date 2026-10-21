// `"build": { "electronRuntime": "online" }` — a desktop package that carries
// no Electron and starts from the per-user shared store, downloading into it
// on first start with a progress window (src/electron/shared-runtime.ts,
// runtime-dialog.ts). These pin the store's location, the start sequence
// (find → download with progress → Retry/Quit on failure → cancel), the use
// records that keep `am prune` from deleting a runtime an installed app still
// needs, the updater's pre-download, and the packaging decisions.
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { basename, join, resolve } from "@std/path";
import {
  bakedElectronRuntime,
  electronBinIn,
  electronSlug,
  electronZipName,
  fetchVerifiedZip,
  runtimeShasBySlug,
} from "../src/electron/electron-runtime-fetch.ts";
import {
  electronFuseBinary,
  fusesAreOff,
} from "../src/electron/electron-fuses.ts";
import {
  enclosingMacApp,
  ensureSharedElectron,
  fillWords,
  macWindowBundle,
  plistString,
  PREVIOUS_ANSWER,
  readSharedUses,
  readyHeading,
  recordSharedUse,
  sharedElectronDir,
  sharedElectronReady,
  sharedElectronRoot,
  sharedFailureMessage,
  sharedRuntimeForStart,
  windowDirName,
} from "../src/electron/shared-runtime.ts";
import {
  _fileProgress,
  browserBackend,
  browserPage,
  type DialogBackend,
  downloadDetail,
  encodedCommand,
  hasDesktop,
  lookArg,
  MAC_ASK_JXA,
  MAC_LOOK_JS,
  MAC_PROGRESS_JXA,
  macAnswer,
  pangoText,
  powershellCommand,
  type ProgressDialog,
  progressLine,
  type RetryAnswer,
  WINDOWS_ASK_PS,
  WINDOWS_PROGRESS_PS,
  windowsAnswer,
  zenityAnswer,
  zenityAskArgs,
  zenityEnding,
  zenityProgressArgs,
} from "../src/electron/runtime-dialog.ts";
import { identityDialogColors } from "../src/build/app-theme.ts";
import { resolveSplash } from "../src/build/splash.ts";
import { splashSession } from "../src/electron/splash-session.ts";
import {
  askElectronRuntime,
  classifyElectronRuntimeProbe,
  parseElectronRuntimeAnswer,
  prefetchSharedElectron,
} from "../src/server/updates-electron.ts";
import { resolveElectronRuntime } from "../src/build/build-config.ts";
import { _appRun, _winLauncherBat } from "../src/build/build-electron.ts";
import { classifyTarget } from "../src/server/updates-apply.ts";
import { planSharedPrune } from "../src/build/electron-cache.ts";
import { findElectronBin } from "../src/electron/electron-spawn.ts";
import type { Log } from "../src/electron/electron-shared.ts";
import { VALID_BUILD_KEYS } from "../src/server/config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { FUSE_WIRE, runtimeZip } from "./electron-runtime-stub.ts";

const V = "9.9.9";
const SLUG = electronSlug();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Electron's release host, served from memory. `fail` answers every zip
 *  request with a 503 until it is switched off. */
async function release(bytes: Uint8Array) {
  const sums = `${await sha256Hex(bytes)} *${electronZipName(V, SLUG)}\n`;
  const state = { fail: false, zipFetches: 0 };
  const f = ((url: string | URL | Request) => {
    const href = String(url instanceof Request ? url.url : url);
    if (href.endsWith("SHASUMS256.txt")) {
      return Promise.resolve(new Response(sums));
    }
    state.zipFetches++;
    if (state.fail) {
      return Promise.resolve(
        new Response("down", { status: 503, statusText: "Unavailable" }),
      );
    }
    // Two chunks, as a real download arrives: the bar moves before the end.
    const half = Math.floor(bytes.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, half));
        c.enqueue(bytes.slice(half));
        c.close();
      },
    });
    return Promise.resolve(
      new Response(body, {
        headers: { "content-length": String(bytes.length) },
      }),
    );
  }) as typeof fetch;
  return { fetch: f, state };
}

/** A dialog backend that records what it was asked, and answers the
 *  failure question from a script. */
function fakeDialog(answers: RetryAnswer[] = []) {
  const seen = {
    opened: [] as string[],
    updates: [] as Array<{ fraction: number | null; detail: string }>,
    asked: [] as string[],
    closed: 0,
  };
  let cancel: (() => void) | null = null;
  const backend: DialogBackend = {
    name: "fake",
    progress(title, heading) {
      seen.opened.push(`${title} | ${heading}`);
      const cancelled = new Promise<void>((r) => (cancel = r));
      const d: ProgressDialog = {
        update(fraction, detail) {
          seen.updates.push({ fraction, detail });
        },
        cancelled,
        lost: new Promise<string>(() => {}),
        close() {
          seen.closed++;
          return Promise.resolve();
        },
      };
      return Promise.resolve(d);
    },
    ask(_t, message) {
      seen.asked.push(message);
      return Promise.resolve(answers.shift() ?? "quit");
    },
  };
  return { backend, seen, cancel: () => cancel?.() };
}

const quiet = {
  info: (_: string) => {},
  error: (_: string) => {},
};

// ── where the store is ─────────────────────────────────────────────────────

Deno.test("shared store: each OS's per-user app-DATA folder, never a cache", () => {
  const home = () => "/h";
  const none = () => undefined;
  assertEquals(
    sharedElectronRoot({ os: "linux", env: none, home }),
    join("/h", ".local", "share", "aio", "electron"),
  );
  assertEquals(
    sharedElectronRoot({
      os: "linux",
      env: (k) => k === "XDG_DATA_HOME" ? "/data" : undefined,
      home,
    }),
    join("/data", "aio", "electron"),
  );
  assertEquals(
    sharedElectronRoot({ os: "darwin", env: none, home }),
    join("/h", "Library", "Application Support", "aio", "electron"),
  );
  // Windows: LOCAL app data — 250 MB must never roam with a profile.
  assertEquals(
    sharedElectronRoot({
      os: "windows",
      env: (k) =>
        k === "LOCALAPPDATA" ? "C:\\Users\\u\\AppData\\Local" : undefined,
      home,
    }),
    join("C:\\Users\\u\\AppData\\Local", "aio", "electron"),
  );
  assertEquals(
    sharedElectronRoot({ os: "windows", env: none, home }),
    join("/h", "AppData", "Local", "aio", "electron"),
  );
  // An empty XDG_DATA_HOME is unset, not "the current directory".
  assertEquals(
    sharedElectronRoot({
      os: "linux",
      env: (k) => k === "XDG_DATA_HOME" ? "" : undefined,
      home,
    }),
    join("/h", ".local", "share", "aio", "electron"),
  );
  // The override wins everywhere.
  assertEquals(
    sharedElectronRoot({
      os: "darwin",
      env: (k) => k === "AIO_SHARED_ELECTRON_DIR" ? "/x" : undefined,
      home,
    }),
    resolve("/x"),
  );
  assertEquals(
    sharedElectronDir("v44.7.0", "linux-x64", "/s"),
    join("/s", "44.7.0-linux-x64"),
  );
});

// ── the start ──────────────────────────────────────────────────────────────

Deno.test("shared start: downloads into the store with a progress window, fuses it, records the install, and the next start finds it", async () => {
  const tmp = await tempDir("shared-start-");
  try {
    const rel = await release(await runtimeZip(tmp));
    const root = join(tmp, "store");
    const ui = fakeDialog();
    const exe = await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "mount", "app"),
      installed: join(tmp, "app.AppImage"),
      title: "Notes",
      log: quiet,
      root,
      fetch: rel.fetch,
      dialog: ui.backend,
    });
    if (Deno.build.os !== "darwin") {
      assertEquals(exe, electronBinIn(sharedElectronDir(V, SLUG, root)));
    }
    assertEquals(ui.seen.opened, ["Notes | Getting Notes ready"]);
    assert(
      ui.seen.updates.some((u) =>
        /^Downloading Electron 9\.9\.9/.test(u.detail)
      ),
    );
    assertEquals(ui.seen.closed, 1);
    // Fused like a bundled runtime: a shipped app never starts unfused.
    const dir = sharedElectronDir(V, SLUG, root);
    assert(
      fusesAreOff(
        await Deno.readFile(electronFuseBinary(dir, Deno.build.os)),
      ),
    );
    // The record names the INSTALLED file (the AppImage), not its mount.
    const uses = await readSharedUses(root);
    assertEquals(uses.length, 1);
    assertEquals(uses[0]!.use!.exe, join(tmp, "app.AppImage"));
    assertEquals(uses[0]!.use!.version, V);

    // Second start: no window, no download.
    const again = fakeDialog();
    await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "mount", "app"),
      title: "Notes",
      log: quiet,
      root,
      fetch: rel.fetch,
      dialog: again.backend,
    });
    assertEquals(again.seen.opened, []);
    assertEquals(rel.state.zipFetches, 1);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared start: show \"firstStart\" — the first start's download runs INSIDE the app's splash (its downloadText filled, its bar the download's, no other window); a later start shows nothing at all", async () => {
  const tmp = await tempDir("shared-firststart-");
  try {
    const rel = await release(await runtimeZip(tmp));
    const root = join(tmp, "store");
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
      ),
      (ch) => ch.charCodeAt(0),
    );
    const r = resolveSplash({
      build: {
        splash: {
          image: "s.png",
          show: "firstStart",
          downloadText: "Getting {title} ready · {got} / {total} MB",
          progress: true,
        },
      },
    }, { root: "/p", appId: "com.example.notes", read: () => png });
    if ("error" in r) throw new Error(r.error);
    const start = async () => {
      const seen = {
        opened: [] as string[],
        lines: [] as Array<[number | null, string]>,
      };
      const log: string[] = [];
      const ses = splashSession(r.splash!, {
        title: "Notes",
        log: { info: (m) => log.push(m), error: (m) => log.push(`! ${m}`) },
        tickMs: 2,
        backend: () =>
          Promise.resolve({
            name: "fake splash",
            open(title: string, text: string) {
              seen.opened.push(`${title} | ${text}`);
              return Promise.resolve({
                update: (f: number | null, t: string) =>
                  void seen.lines.push([f, t]),
                shown: Promise.resolve(),
                cancelled: new Promise<void>(() => {}),
                lost: new Promise<string>(() => {}),
                close: () => Promise.resolve(),
              });
            },
          }),
      });
      ses.open();
      const plain = fakeDialog();
      const exe = await sharedRuntimeForStart({
        version: V,
        slug: SLUG,
        execPath: join(tmp, "mount", "app"),
        title: "Notes",
        log: quiet,
        root,
        fetch: rel.fetch,
        dialog: plain.backend,
        splash: ses,
      });
      ses.ready(); // the app's window is up
      await new Promise((r) => setTimeout(r, 10));
      ses.shutdown();
      return { exe, seen, log, plain: plain.seen.opened };
    };
    const first = await start();
    assert(first.exe);
    assertEquals(first.plain, [], "no download window beside the splash");
    assertEquals(first.seen.opened.length, 1, "the splash, once");
    assert(
      first.seen.lines.some(([f, t]) =>
        f !== null && f > 0 && /^Getting Notes ready · \d+ \/ \d+ MB$/.test(t)
      ),
      JSON.stringify(first.seen.lines),
    );
    // Its look is the app's identity (no colours set) — the text over the
    // image the colour that reads on it — its bar shown.
    const id = identityDialogColors("com.example.notes").light;
    assertEquals(r.splash!.light, { ...id, text: r.splash!.light.text });
    assertEquals(r.splash!.light.text, "#ffffff"); // a black 1×1 image
    assertEquals(r.splash!.progress, true);
    const later = await start();
    assert(later.exe);
    assertEquals([later.seen.opened, later.plain], [[], []], "nothing shown");
    assert(
      later.log.some((l) =>
        l.includes('not shown (show: "firstStart", no download)')
      ),
    );
    assertEquals(rel.state.zipFetches, 1);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared start: electron.downloadWindow's words — the heading, the detail ({got} / {total} filled as it downloads) and the Retry / Quit question ({reason})", async () => {
  const tmp = await tempDir("shared-words-");
  try {
    const rel = await release(await runtimeZip(tmp));
    const root = join(tmp, "store");
    const words = {
      heading: "Setting up {title}",
      text: "Installing dependencies · {got} of {total} MB",
      question: "{title} could not get Electron {version}: {reason}",
    };
    const ui = fakeDialog();
    await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: quiet,
      root,
      fetch: rel.fetch,
      dialog: ui.backend,
      words,
    });
    assertEquals(ui.seen.opened, ["Notes | Setting up Notes"]);
    assert(
      ui.seen.updates.some((u) =>
        /^Installing dependencies · \d+ of (\d+|\?) MB$/.test(u.detail)
      ),
      JSON.stringify(ui.seen.updates),
    );
    // The question, on a failed download.
    rel.state.fail = true;
    const q = fakeDialog(["quit"]);
    await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: quiet,
      root: join(tmp, "store2"),
      fetch: rel.fetch,
      dialog: q.backend,
      words,
    });
    assertEquals(q.seen.asked.length, 1);
    assert(
      q.seen.asked[0]!.startsWith("Notes could not get Electron 9.9.9: "),
      q.seen.asked[0],
    );
    assert(!q.seen.asked[0]!.includes("\n"), "the reason's first line only");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("dialog: fillWords fills {title} {version} {got} {total} {reason}, leaves any other {x}", () => {
  assertEquals(
    fillWords("{title} {version} {got}/{total} {reason} {pct}", {
      title: "N",
      version: "1.2.3",
      got: 22e6,
      total: 123e6,
      reason: "offline",
    }),
    "N 1.2.3 22/123 offline {pct}",
  );
  assertEquals(
    fillWords("{got} of {total}", { title: "", version: "" }),
    "0 of ?",
  );
});

Deno.test("shared start: a failed download asks Retry / Quit — Retry tries again, Quit ends the start", async () => {
  const tmp = await tempDir("shared-retry-");
  try {
    const rel = await release(await runtimeZip(tmp));
    rel.state.fail = true;
    const root = join(tmp, "store");
    // Quit: null, nothing in the store.
    const q = fakeDialog(["quit"]);
    const none = await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: quiet,
      root,
      fetch: rel.fetch,
      dialog: q.backend,
    });
    assertEquals(none, null);
    assertEquals(q.seen.asked.length, 1);
    assertStringIncludes(q.seen.asked[0]!, "Notes needs Electron 9.9.9");
    // A download that failed: the connection is the advice.
    assertStringIncludes(q.seen.asked[0]!, "could not be downloaded");
    assertStringIncludes(q.seen.asked[0]!, "internet connection");
    assertEquals(await sharedElectronReady(V, SLUG, root), false);

    // Retry after the network comes back: it starts.
    const r = fakeDialog(["retry"]);
    const ask = r.backend.ask;
    r.backend.ask = (t, m) => {
      rel.state.fail = false; // the user fixed the network, then pressed Retry
      return ask(t, m);
    };
    rel.state.fail = true;
    const exe = await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: quiet,
      root,
      fetch: rel.fetch,
      dialog: r.backend,
    });
    assert(exe);
    assertEquals(r.seen.asked.length, 1);
    assertEquals(await sharedElectronReady(V, SLUG, root), true);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared start: with no desktop the failure is final — no question, null", async () => {
  const tmp = await tempDir("shared-headless-");
  try {
    const rel = await release(await runtimeZip(tmp));
    rel.state.fail = true;
    const lines: string[] = [];
    const exe = await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: { info: () => {}, error: (m) => lines.push(m) },
      root: join(tmp, "store"),
      fetch: rel.fetch,
      dialog: null,
    });
    assertEquals(exe, null);
    assert(lines.some((l) => l.includes("could not get Electron 9.9.9")));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared start: a store that cannot be written says so at once — not a download failure, not after a lock wait", async () => {
  const tmp = await tempDir("shared-unwritable-");
  try {
    const rel = await release(await runtimeZip(tmp));
    // The store's place is a FILE: nothing can be made under it.
    const root = join(tmp, "store");
    await Deno.writeTextFile(root, "");
    const ui = fakeDialog(["quit"]);
    const t0 = Date.now();
    const exe = await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: quiet,
      root,
      fetch: rel.fetch,
      dialog: ui.backend,
    });
    assertEquals(exe, null);
    assert(Date.now() - t0 < 10_000, "it waited instead of saying so");
    assertEquals(rel.state.zipFetches, 0);
    assertStringIncludes(ui.seen.asked[0]!, "cannot write to");
    assertStringIncludes(ui.seen.asked[0]!, "could not be prepared");
    assert(!ui.seen.asked[0]!.includes("internet connection"));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared start: a cancel ends the start even when the download does not listen (another start's lock, a fetch that ignores the abort)", async () => {
  const tmp = await tempDir("shared-cancel-deaf-");
  try {
    const bytes = await runtimeZip(tmp);
    const sums = `${await sha256Hex(bytes)} *${electronZipName(V, SLUG)}\n`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = (async (url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      if (href.endsWith("SHASUMS256.txt")) return new Response(sums);
      await gate; // deaf to the abort signal
      return new Response("down", { status: 503 });
    }) as typeof fetch;
    const ui = fakeDialog();
    const started = sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: quiet,
      root: join(tmp, "store"),
      fetch: f,
      dialog: ui.backend,
    });
    while (ui.seen.opened.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ui.cancel();
    assertEquals(await started, null);
    assertEquals(ui.seen.asked, []);
    release(); // let the deaf download end, so nothing outlives the test
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared start: closing the progress window cancels the start", async () => {
  const tmp = await tempDir("shared-cancel-");
  try {
    const bytes = await runtimeZip(tmp);
    const sums = `${await sha256Hex(bytes)} *${electronZipName(V, SLUG)}\n`;
    // A download that never finishes on its own.
    const f = ((url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      if (href.endsWith("SHASUMS256.txt")) {
        return Promise.resolve(new Response(sums));
      }
      return Promise.resolve(new Response(new ReadableStream({ start() {} })));
    }) as typeof fetch;
    const ui = fakeDialog();
    const lines: string[] = [];
    const started = sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: { info: () => {}, error: (m) => lines.push(m) },
      root: join(tmp, "store"),
      fetch: f,
      dialog: ui.backend,
    });
    while (ui.seen.opened.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ui.cancel();
    assertEquals(await started, null);
    assert(lines.some((l) => l.includes("the start was cancelled")));
    assertEquals(ui.seen.asked, []); // a cancel is not a failure to ask about
    // The download's cleanup is done when the start returns: no stage, no
    // lock (it returned while they were being removed — on Windows the
    // test's own temp-dir removal then raced it).
    const left = [...Deno.readDirSync(join(tmp, "store"))].map((e) => e.name)
      .filter((n) => n.includes(".incoming.") || n.endsWith(".lock"));
    assertEquals(left, [], "a cancelled start left its stage or lock");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("findElectronBin: a shared-runtime binary goes to the store, and the empty ELECTRON_PATH its package sets is not a warning", async () => {
  const tmp = await tempDir("shared-find-");
  const ep = Deno.env.get("ELECTRON_PATH");
  try {
    const dist = join(tmp, "dist");
    await Deno.mkdir(dist);
    await Deno.writeTextFile(
      join(dist, "electron.json"),
      JSON.stringify({ version: V, runtime: "shared" }),
    );
    assertEquals(await bakedElectronRuntime(dist), "shared");
    const execPath = join(
      tmp,
      "pkg",
      Deno.build.os === "windows" ? "app.exe" : "app",
    );
    // What the Windows exe's launcher sets: the install's own electron\, which
    // a shared package leaves empty.
    Deno.env.set("ELECTRON_PATH", electronBinIn(join(tmp, "pkg", "electron")));
    const errors: string[] = [];
    const log: Log = {
      info: () => {},
      error: (m: string) => errors.push(m),
    } as unknown as Log;
    let asked: {
      version: string;
      title: string;
      installed?: string;
      colors?: unknown;
    } | null = null;
    const colors = identityDialogColors("com.example.notes");
    const bin = await findElectronBin(log, {
      distDir: dist,
      compiled: true,
      execPath,
      title: "Notes",
      colors,
      sharedRuntime: (o) => {
        asked = {
          version: o.version,
          title: o.title,
          installed: o.installed,
          colors: o.colors,
        };
        return Promise.resolve("/store/electron");
      },
    });
    assertEquals(bin, "/store/electron");
    // The app's colours reach the download window and the question.
    assertEquals(asked, {
      version: V,
      title: "Notes",
      installed: execPath,
      colors,
    });
    assertEquals(
      errors.filter((e) => e.includes("ELECTRON_PATH")),
      [],
      errors.join("\n"),
    );
  } finally {
    if (ep === undefined) Deno.env.delete("ELECTRON_PATH");
    else Deno.env.set("ELECTRON_PATH", ep);
    await dropTempDir(tmp);
  }
});

Deno.test("bakedElectronRuntime: no record, a bundled record, and junk all mean bundled", async () => {
  const tmp = await tempDir("shared-baked-");
  try {
    assertEquals(await bakedElectronRuntime(undefined), "bundled");
    assertEquals(await bakedElectronRuntime(tmp), "bundled");
    await Deno.writeTextFile(join(tmp, "electron.json"), `{"version":"1.0.0"}`);
    assertEquals(await bakedElectronRuntime(tmp), "bundled");
    await Deno.writeTextFile(
      join(tmp, "electron.json"),
      `{"version":"1.0.0","runtime":"SHARED"}`,
    );
    assertEquals(await bakedElectronRuntime(tmp), "bundled");
  } finally {
    await dropTempDir(tmp);
  }
});

// ── the records and `am prune` ─────────────────────────────────────────────

Deno.test("shared store prune: a runtime an installed app names stays however old; one nobody names goes; a gone app's record goes", async () => {
  const tmp = await tempDir("shared-prune-");
  try {
    const root = join(tmp, "store");
    for (const v of ["1.0.0", "2.0.0"]) {
      const d = join(root, `${v}-${SLUG}`);
      await Deno.mkdir(d, { recursive: true });
      await Deno.writeTextFile(join(d, "f"), "x");
    }
    const live = join(tmp, "live-app");
    await Deno.writeTextFile(live, "");
    await recordSharedUse({ exe: live, version: "1.0.0", slug: SLUG }, {
      root,
    });
    await recordSharedUse(
      { exe: join(tmp, "uninstalled"), version: "2.0.0", slug: SLUG },
      { root },
    );
    // Past the grace a start's use stamp buys.
    const later = new Date(Date.now() + 60 * 60_000);
    const plan = await planSharedPrune(root, later);
    const by = (n: string) => plan.decisions.find((d) => d.name === n)!;
    assertEquals(by(`1.0.0-${SLUG}`).keep, true);
    assertStringIncludes(by(`1.0.0-${SLUG}`).why, live);
    assertEquals(by(`2.0.0-${SLUG}`).keep, false);
    const record = plan.decisions.find((d) => d.kind === "record")!;
    assertEquals(record.keep, false);
    assertStringIncludes(record.why, "uninstalled");

    // Inside the grace, a runtime nobody names yet stays: a start that just
    // found it may not have written its record.
    const now = await planSharedPrune(root);
    assertEquals(
      now.decisions.find((d) => d.name === `2.0.0-${SLUG}`)!.keep,
      true,
    );

    // A window an app is making right now stays.
    const making = join(root, "windows", "com.x.app", ".stage-1");
    await Deno.mkdir(making, { recursive: true });
    const win = async (at?: Date) =>
      (await planSharedPrune(root, at)).decisions.find((d) =>
        d.name === "windows/com.x.app"
      )!;
    const w = await win();
    assertEquals(w.keep, true);
    assertStringIncludes(w.why, "right now");
    // …but a stage a killed start left behind stops protecting it.
    assertEquals((await win(later)).keep, false);

    // One record that cannot be read keeps EVERY runtime — and is named.
    await Deno.writeTextFile(join(root, "apps", "broken.json"), "{not json");
    const careful = await planSharedPrune(root, later);
    const rts = careful.decisions.filter((d) => d.kind === "runtime");
    assert(rts.every((d) => d.keep));
    assertStringIncludes(
      rts.find((d) => d.name === `2.0.0-${SLUG}`)!.why,
      "apps/broken.json",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared use records: one per app AND Electron version; an app keeps its newest two (current + next or rollback)", async () => {
  const tmp = await tempDir("shared-records-");
  try {
    const root = join(tmp, "store");
    const exe = join(tmp, "app");
    await Deno.writeTextFile(exe, "");
    for (const v of ["1.0.0", "2.0.0", "3.0.0"]) {
      await recordSharedUse({ exe, version: v, slug: SLUG }, { root });
      await new Promise((r) => setTimeout(r, 5)); // distinct `at`
    }
    // The newest again: rewritten in place, not a fourth.
    await recordSharedUse({ exe, version: "3.0.0", slug: SLUG }, { root });
    const versions = (await readSharedUses(root)).map((u) => u.use!.version)
      .sort();
    assertEquals(versions, ["2.0.0", "3.0.0"]);

    // Updates that fetched 4 then 5 but never swapped: the version the app
    // starts from (3) and its rollback (2) stay, plus only the newest update.
    for (const v of ["4.0.0", "5.0.0"]) {
      await new Promise((r) => setTimeout(r, 5));
      await recordSharedUse({ exe, version: v, slug: SLUG, pending: true }, {
        root,
      });
    }
    // …and an update's note never demotes a version already started from.
    await recordSharedUse(
      { exe, version: "3.0.0", slug: SLUG, pending: true },
      {
        root,
      },
    );
    const after = await readSharedUses(root);
    assertEquals(
      after.map((u) => `${u.use!.version}${u.use!.pending ? "?" : ""}`).sort(),
      ["2.0.0", "3.0.0", "5.0.0?"],
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("shared store prune: an absent store is an empty plan", async () => {
  const tmp = await tempDir("shared-prune-none-");
  try {
    assertEquals((await planSharedPrune(join(tmp, "nope"))).decisions, []);
  } finally {
    await dropTempDir(tmp);
  }
});

// ── updates ────────────────────────────────────────────────────────────────

Deno.test("update pre-download: a shared build's Electron is fetched before the swap; a bundled or older build is left alone; a failure refuses the update", async () => {
  const fetched: string[] = [];
  const ensure = ((v: string) => {
    fetched.push(v);
    return Promise.resolve("/s");
  }) as unknown as typeof ensureSharedElectron;
  const recorded: string[] = [];
  const base = {
    log: () => {},
    ensure,
    ready: () => Promise.resolve(false),
    record: ((u: { exe: string; version: string }) => {
      recorded.push(`${u.exe}@${u.version}`);
      return Promise.resolve();
    }) as unknown as typeof recordSharedUse,
    installed: "/installed/app",
    slug: "linux-x64",
  };
  const PIN = "a".repeat(64);
  const answer = (runtime: string, version?: string, sha256 = PIN) => () =>
    Promise.resolve({ kind: "answer" as const, runtime, version, sha256 });
  await prefetchSharedElectron("/new", {
    ...base,
    ask: answer("bundled", "1"),
  });
  await prefetchSharedElectron("/new", {
    ...base,
    ask: () => Promise.resolve({ kind: "old" as const }),
  });
  assertEquals(fetched, []);
  assertEquals(recorded, []);
  await prefetchSharedElectron("/new", {
    ...base,
    ready: () => Promise.resolve(true),
    ask: answer("shared", "45.0.0"),
  });
  assertEquals(fetched, []);
  // Already there, still recorded: a prune before the first start keeps it.
  assertEquals(recorded, ["/installed/app@45.0.0"]);
  await prefetchSharedElectron("/new", {
    ...base,
    ask: answer("shared", "45.0.0"),
  });
  assertEquals(fetched, ["45.0.0"]);
  const refused = async (
    o: Partial<Parameters<typeof prefetchSharedElectron>[1]>,
  ) =>
    ((await assertRejects(() =>
      prefetchSharedElectron("/new", { ...base, ...o })
    )) as Error).message;
  assertStringIncludes(
    await refused({
      ask: answer("shared", "46.0.0"),
      ensure: (() =>
        Promise.reject(
          new Error("offline"),
        )) as unknown as typeof ensureSharedElectron,
    }),
    "update was NOT installed",
  );
  // An Electron package that could not answer at all is NOT taken as
  // "carries its own".
  const failed = () =>
    Promise.resolve({ kind: "failed" as const, why: "exited 1" });
  assertStringIncludes(
    await refused({ ask: failed, markedShared: true }),
    "exited 1",
  );
  // Not marked shared and cannot answer: logged, installed as before.
  const said: string[] = [];
  await prefetchSharedElectron("/new", {
    ...base,
    ask: failed,
    log: (m) => said.push(m),
  });
  assert(said.some((m) => m.includes("exited 1")));
  // A package marked shared that does not answer shared is refused.
  assertStringIncludes(
    await refused({ ask: answer("bundled", "1"), markedShared: true }),
    "shared-runtime package",
  );
  assertStringIncludes(
    await refused({ ask: answer("shared") }),
    "did not say which",
  );
  // No pinned checksum: refused — never downloaded on the network's word.
  fetched.length = 0;
  assertStringIncludes(
    await refused({
      ask: () =>
        Promise.resolve({
          kind: "answer" as const,
          runtime: "shared",
          version: "47.0.0",
        }),
    }),
    "no checksum",
  );
  assertEquals(fetched, []);
  // The pin is what the download is held to.
  let pinned: string | undefined;
  await prefetchSharedElectron("/new", {
    ...base,
    ask: answer("shared", "48.0.0"),
    ensure: ((_v: string, _s: string, o: { sha256?: string }) => {
      pinned = o.sha256;
      return Promise.resolve("/s");
    }) as unknown as typeof ensureSharedElectron,
  });
  assertEquals(pinned, PIN);
});

Deno.test("update pre-download: a browser-default online binary fetches no Electron; an Electron default still does", async () => {
  // todo "Owner decides": a plain `binary` of an online app answered
  // "shared", so every update fetched ~100 MB of Electron for a binary that
  // only ever opens in a browser. The build now bakes the default client.
  const fetched: string[] = [];
  const said: string[] = [];
  const base = {
    log: (m: string) => said.push(m),
    ensure: ((v: string) => {
      fetched.push(v);
      return Promise.resolve("/s");
    }) as unknown as typeof ensureSharedElectron,
    ready: () => Promise.resolve(false),
    record: (() => Promise.resolve()) as unknown as typeof recordSharedUse,
    installed: "/installed/app",
    slug: "linux-x64",
  };
  const answer = (client?: string) => () =>
    Promise.resolve({
      kind: "answer" as const,
      runtime: "shared",
      version: "45.0.0",
      sha256: "a".repeat(64),
      ...(client ? { client } : {}),
    });
  for (const client of ["browser", "server-only"]) {
    await prefetchSharedElectron("/new", { ...base, ask: answer(client) });
  }
  assertEquals(fetched, []);
  assert(said.some((m) => m.includes(`opens as "browser"`)), said.join("\n"));
  await prefetchSharedElectron("/new", { ...base, ask: answer("electron") });
  await prefetchSharedElectron("/new", { ...base, ask: answer() }); // pre-field build
  assertEquals(fetched, ["45.0.0", "45.0.0"]);
  // A desktop PACKAGE is Electron whatever it says: still fetched.
  await prefetchSharedElectron("/new", {
    ...base,
    ask: answer("browser"),
    markedShared: true,
  });
  assertEquals(fetched.length, 3);
  // The answer line carries the field through.
  assertEquals(
    parseElectronRuntimeAnswer(
      `{"runtime":"shared","version":"45.0.0","client":"browser"}`,
    )?.client,
    "browser",
  );
});

Deno.test("pinned checksum: a download is held to the build's pin alone — a forged zip WITH a forged checksum list fails, and the network's list is never needed", async () => {
  const tmp = await tempDir("shared-pin-");
  try {
    const real = await runtimeZip(tmp);
    const pin = await sha256Hex(real);
    const forged = new Uint8Array([...real, 0x00]);
    // A host that serves the forgery and a checksum list that vouches for it.
    const evil = (async (url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      if (href.endsWith("SHASUMS256.txt")) {
        return new Response(
          `${await sha256Hex(forged)} *${electronZipName(V, SLUG)}\n`,
        );
      }
      return new Response(forged.slice().buffer as ArrayBuffer);
    }) as typeof fetch;
    const err = await assertRejects(() =>
      fetchVerifiedZip(V, SLUG, { log: () => {}, fetch: evil, sha256: pin })
    );
    assertStringIncludes((err as Error).message, "integrity check FAILED");
    assertStringIncludes((err as Error).message, "pinned");
    // The real zip, from a host whose checksum list is missing: passes.
    const honest = ((url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      return Promise.resolve(
        href.endsWith("SHASUMS256.txt")
          ? new Response("gone", { status: 404 })
          : new Response(real.slice().buffer as ArrayBuffer),
      );
    }) as typeof fetch;
    const ok = await fetchVerifiedZip(V, SLUG, {
      log: () => {},
      fetch: honest,
      sha256: pin,
    });
    assertEquals(ok.sha256, pin);

    // A start whose build pinned NO checksum downloads nothing.
    const rel = await release(real);
    const ui = fakeDialog(["quit"]);
    const exe = await sharedRuntimeForStart({
      version: V,
      slug: SLUG,
      execPath: join(tmp, "app"),
      title: "Notes",
      log: quiet,
      root: join(tmp, "store"),
      fetch: rel.fetch,
      dialog: ui.backend,
      sha256: null,
    });
    assertEquals(exe, null);
    assertEquals(rel.state.zipFetches, 0);
    assertStringIncludes(ui.seen.asked[0]!, "no checksum");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("update pre-download: progress reaches the updates cell once per whole percent, not once per chunk", async () => {
  const seen: number[] = [];
  const marks: string[] = [];
  await prefetchSharedElectron("/new", {
    log: () => {},
    installed: "/installed/app",
    slug: "linux-x64",
    ask: () =>
      Promise.resolve({
        kind: "answer" as const,
        runtime: "shared",
        version: "45.0.0",
        sha256: "a".repeat(64),
      }),
    ready: () => Promise.resolve(false),
    record: (() => Promise.resolve()) as unknown as typeof recordSharedUse,
    ensure: ((
      _v: string,
      _s: string,
      o: { onBytes: (got: number, total: number) => void },
    ) => {
      const total = 158_000_000;
      for (let got = 0; got <= total; got += 16_384) o.onBytes(got, total);
      o.onBytes(total, total);
      return Promise.resolve("/s");
    }) as unknown as typeof ensureSharedElectron,
    onProgress: (f) => {
      if (marks.at(-1) !== "progress") marks.push("progress");
      seen.push(f);
    },
    // The leg begins before its first byte, and its size is said once.
    onDownload: () => marks.push("download"),
    onTotal: (b) => marks.push(`total ${b}`),
  });
  assertEquals(marks, ["download", "total 158000000", "progress"]);
  assertEquals(seen.length, 101);
  assertEquals(seen[0], 0);
  assertEquals(seen.at(-1), 1);
});

Deno.test("download failure: the reason Deno 2.9 keeps in the fetch error's cause is named, not a bare 'fetch failed'", async () => {
  const refused = (() =>
    Promise.reject(
      new TypeError("fetch failed", {
        cause: new Error(
          "tcp connect error: Connection refused (os error 10061)",
        ),
      }),
    )) as typeof fetch;
  const err = await assertRejects(() =>
    fetchVerifiedZip(V, SLUG, {
      log: () => {},
      fetch: refused,
      sha256: "0".repeat(64),
    })
  );
  assertEquals(
    (err as Error).message,
    "fetch failed: tcp connect error: Connection refused (os error 10061)",
  );
  // A message that already carries its cause is not doubled.
  const plain = (() =>
    Promise.reject(
      new TypeError("offline: x", { cause: "x" }),
    )) as typeof fetch;
  const err2 = await assertRejects(() =>
    fetchVerifiedZip(V, SLUG, {
      log: () => {},
      fetch: plain,
      sha256: "0".repeat(64),
    })
  );
  assertEquals((err2 as Error).message, "offline: x");
});

Deno.test("pinned checksums: every platform's runtime zip from a release's list — symbols and other assets left out", () => {
  const h = (c: string) => c.repeat(64);
  const list = [
    `${h("a")} *electron-v44.7.0-linux-x64.zip`,
    `${h("b")} *electron-v44.7.0-darwin-arm64.zip`,
    `${h("C")}  electron-v44.7.0-win32-x64.zip`,
    `${h("d")} *electron-v44.7.0-linux-x64-symbols.zip`,
    `${h("e")} *electron-v44.7.0-darwin-x64-dsym.zip`,
    `${h("f")} *chromedriver-v44.7.0-linux-x64.zip`,
    `${h("1")} *electron-v44.7.01-linux-x64.zip`,
  ].join("\n");
  assertEquals(runtimeShasBySlug(list, "v44.7.0"), {
    "linux-x64": h("a"),
    "darwin-arm64": h("b"),
    "win32-x64": h("c"),
  });
});

Deno.test("--aio-electron-runtime probe: an old build refuses the flag by name; any other failure is a failure", () => {
  const run = (
    o: Partial<
      { success: boolean; code: number; stdout: string; stderr: string }
    >,
  ) =>
    classifyElectronRuntimeProbe({
      success: false,
      code: 1,
      stdout: "",
      stderr: "",
      ...o,
    });
  assertEquals(
    run({
      success: true,
      code: 0,
      stdout: `{"runtime":"shared","version":"1"}`,
    }),
    { kind: "answer", runtime: "shared", version: "1" },
  );
  assertEquals(
    run({ stderr: "error: unknown flag: --aio-electron-runtime\nhint" }),
    { kind: "old" },
  );
  assertEquals(run({ code: 139, stderr: "Segmentation fault" }).kind, "failed");
  assertEquals(run({ success: true, code: 0, stdout: "hi" }).kind, "failed");
});

Deno.test("--aio-electron-runtime answer: the last JSON line wins over anything the app printed first", () => {
  assertEquals(
    parseElectronRuntimeAnswer(
      `hello from a module\n{"runtime":"shared","version":"44.7.0"}\n`,
    ),
    { runtime: "shared", version: "44.7.0" },
  );
  assertEquals(parseElectronRuntimeAnswer(`{"runtime":"none"}`), {
    runtime: "none",
    version: undefined,
  });
  assertEquals(parseElectronRuntimeAnswer("unknown flag"), null);
});

Deno.test("askElectronRuntime: a program that cannot run is a failure, never a throw", async () => {
  assertEquals(
    (await askElectronRuntime("/nonexistent/aio-app")).kind,
    "failed",
  );
});

Deno.test("update targets: a shared Electron AppImage is still an electron-appimage", () => {
  assertEquals(
    classifyTarget({
      execPath: "/tmp/.mount_x/app",
      appImage: "/home/u/app.AppImage",
      electronRuntime: "shared:/tmp/.mount_x",
      appDir: "/tmp/.mount_x",
    }),
    "electron-appimage",
  );
  // Inherited from ANOTHER AppImage that started this one: not ours.
  for (
    const leaked of [
      { electronRuntime: "shared:/tmp/.mount_parent" },
      { electronPath: "/tmp/.mount_parent/electron/electron" },
    ]
  ) {
    assertEquals(
      classifyTarget({
        execPath: "/tmp/.mount_x/app",
        appImage: "/home/u/app.AppImage",
        appDir: "/tmp/.mount_x",
        ...leaked,
      }),
      "appimage",
    );
  }
  assertEquals(
    classifyTarget({ execPath: "/tmp/.mount_x/app", appImage: "/a.AppImage" }),
    "appimage",
  );
});

// ── packaging ──────────────────────────────────────────────────────────────

Deno.test("build.electronRuntime: offline when absent, online on request, anything else refused — and it is a known build key", () => {
  assertEquals(resolveElectronRuntime({}), { mode: "offline" });
  assertEquals(
    resolveElectronRuntime({ build: { electronRuntime: "offline" } }),
    { mode: "offline" },
  );
  assertEquals(
    resolveElectronRuntime({ build: { electronRuntime: "online" } }),
    { mode: "online" },
  );
  // The names before the rename were never released: refused like a typo.
  for (const v of ["Online", "shared", "bundled"]) {
    const bad = resolveElectronRuntime({ build: { electronRuntime: v } });
    assert("error" in bad);
    assertStringIncludes(bad.error, JSON.stringify(v));
  }
  assert(VALID_BUILD_KEYS.has("electronRuntime"));
});

Deno.test("launchers: a shared package points ELECTRON_PATH at nothing — the AppRun says it is shared instead", () => {
  assertStringIncludes(
    _appRun("notes"),
    `export ELECTRON_PATH="$HERE/electron/electron"`,
  );
  const shared = _appRun("notes", true);
  // Only to clear an inherited one (tests/electron-shared-store-hygiene).
  assert(!shared.includes("export ELECTRON_PATH"));
  assertStringIncludes(shared, `export AIO_ELECTRON_RUNTIME="shared:$HERE"`);
  assertStringIncludes(shared, `exec "$HERE/notes" "$@"`);
  assertStringIncludes(_winLauncherBat("notes"), "ELECTRON_PATH");
  const bat = _winLauncherBat("notes", true);
  assert(!bat.includes("ELECTRON_PATH=%"));
  assertStringIncludes(bat, `start "" "%HERE%notes.exe" %*`);
});

// ── dialogs ────────────────────────────────────────────────────────────────

Deno.test("dialog protocol: the progress line, the download detail, and the failure text", () => {
  assertEquals(progressLine(0.456, "Downloading"), "45\tDownloading");
  assertEquals(progressLine(null, "a\tb\nc"), "-1\ta b c");
  assertEquals(progressLine(7, "x"), "100\tx");
  assertEquals(
    downloadDetail("44.7.0", 45e6, 110e6),
    "Downloading Electron 44.7.0 — first start only · 45 / 110 MB",
  );
  assertEquals(
    downloadDetail("44.7.0", 3e6, 0),
    "Downloading Electron 44.7.0 — first start only · 3 MB",
  );
  const msg = sharedFailureMessage(
    "Notes",
    "44.7.0",
    "no route to host\n  https://…",
  );
  assertStringIncludes(msg, "Notes needs Electron 44.7.0");
  assertStringIncludes(msg, "no route to host");
  assert(!msg.includes("https://"));
});

Deno.test("dialog: PowerShell's -EncodedCommand is UTF-16LE base64 of the script", () => {
  const enc = encodedCommand("Write-Host 'Ž'");
  const bytes = Uint8Array.from(atob(enc), (c) => c.charCodeAt(0));
  let back = "";
  for (let i = 0; i < bytes.length; i += 2) {
    back += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  }
  assertEquals(back, "Write-Host 'Ž'");
});

Deno.test("dialog: PowerShell starts from a short, fixed command line that reads the script from a file — a script's own -EncodedCommand outgrows Windows' 32767-character limit (the splash's did: CreateProcessW 206, no splash)", () => {
  const exe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const cmd = powershellCommand(exe);
  assert(cmd.length < 1000, `${cmd.length}`);
  const enc = cmd.split("-EncodedCommand ")[1]!;
  const bytes = Uint8Array.from(atob(enc), (c) => c.charCodeAt(0));
  let boot = "";
  for (let i = 0; i < bytes.length; i += 2) {
    boot += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  }
  assertEquals(
    boot,
    "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:AIO_PS_SCRIPT)))",
  );
  // The only encoded command is that bootstrap: no script is encoded whole.
  const src = Deno.readTextFileSync(
    new URL("../src/electron/runtime-dialog.ts", import.meta.url),
  );
  // (two matches: its definition, and the bootstrap's one call)
  assertEquals(src.match(/encodedCommand\(/g)?.length, 2);
});

Deno.test("dialog: Linux needs a display server; Windows and macOS always have a desktop", () => {
  const none = () => undefined;
  assertEquals(hasDesktop("linux", none), false);
  assertEquals(
    hasDesktop("linux", (k) => k === "WAYLAND_DISPLAY" ? "w" : undefined),
    true,
  );
  assertEquals(hasDesktop("windows", none), true);
  assertEquals(hasDesktop("darwin", none), true);
});

Deno.test("dialog: the browser fallback page escapes its title", () => {
  const page = browserPage(`<script>alert(1)</script> & co`);
  assert(!page.includes("<script>alert"));
  assertStringIncludes(page, "&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
});

// ── macOS window bundle ────────────────────────────────────────────────────

Deno.test("macOS: the installed .app around an executable, plist strings, and the window folder name", () => {
  assertEquals(
    enclosingMacApp("/Applications/Notes.app/Contents/MacOS/notes"),
    "/Applications/Notes.app",
  );
  assertEquals(enclosingMacApp("/usr/local/bin/notes"), null);
  const plist =
    `<dict><key>CFBundleName</key><string>A &amp; B</string><key>CFBundleIdentifier</key><string>app.aio.ab</string></dict>`;
  assertEquals(plistString(plist, "CFBundleName"), "A & B");
  assertEquals(plistString(plist, "CFBundleIdentifier"), "app.aio.ab");
  assertEquals(plistString(plist, "Missing"), null);
  assertEquals(windowDirName("app.aio.notes"), "app.aio.notes");
  assertEquals(windowDirName("../x/y"), ".._x_y");
  assertEquals(windowDirName(".."), "_");
});

Deno.test("macOS: the window bundle is the shared runtime stamped with the app's identity and signed, made once per runtime and identity", async () => {
  const tmp = await tempDir("shared-macwin-");
  try {
    // The shared runtime, as a Mac's store holds it.
    const runtime = join(tmp, "store", `${V}-darwin-arm64`);
    const eapp = join(runtime, "Electron.app", "Contents");
    await Deno.mkdir(join(eapp, "MacOS"), { recursive: true });
    await Deno.mkdir(join(eapp, "Resources"), { recursive: true });
    await Deno.writeTextFile(join(eapp, "MacOS", "Electron"), "bin");
    await Deno.writeTextFile(join(eapp, "Resources", "electron.icns"), "e");
    await Deno.writeTextFile(
      join(eapp, "Info.plist"),
      `<plist><dict>\n\t<key>CFBundleName</key>\n\t<string>Electron</string>\n\t<key>CFBundleIdentifier</key>\n\t<string>com.github.Electron</string>\n</dict></plist>`,
    );
    // The installed app.
    const app = join(tmp, "Applications", "Notes.app");
    await Deno.mkdir(join(app, "Contents", "Resources"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "Contents", "Info.plist"),
      `<plist><dict><key>CFBundleName</key><string>Notes</string><key>CFBundleIdentifier</key><string>app.aio.notes</string><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleIconFile</key><string>AppIcon</string></dict></plist>`,
    );
    await Deno.writeTextFile(
      join(app, "Contents", "Resources", "AppIcon.icns"),
      "icon",
    );
    const calls: string[] = [];
    // `cp` and `codesign` as a Mac runs them (cp: a real copy here).
    const run = async (cmd: string, args: string[]) => {
      // basename: the paths are this host's (`\` on Windows).
      calls.push(`${basename(cmd)} ${basename(args.at(-1) ?? "")}`);
      if (cmd.endsWith("/cp")) {
        const [src, dst] = args.slice(-2) as [string, string];
        await copyTree(src, dst);
      }
      return { ok: true, stderr: "" };
    };
    const root = join(tmp, "store");
    const exe = await macWindowBundle({ runtimeDir: runtime, app, root, run });
    assertEquals(
      exe,
      join(
        root,
        "windows",
        "app.aio.notes",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      ),
    );
    const plist = await Deno.readTextFile(
      join(
        root,
        "windows",
        "app.aio.notes",
        "Electron.app",
        "Contents",
        "Info.plist",
      ),
    );
    assertEquals(plistString(plist, "CFBundleName"), "Notes");
    assertEquals(plistString(plist, "CFBundleIdentifier"), "app.aio.notes");
    assertEquals(plistString(plist, "CFBundleIconFile"), "AppIcon");
    assertEquals(
      await Deno.readTextFile(
        join(
          root,
          "windows",
          "app.aio.notes",
          "Electron.app",
          "Contents",
          "Resources",
          "AppIcon.icns",
        ),
      ),
      "icon",
    );
    assertMatch(calls.join(";"), /codesign Electron\.app/);
    // Again, unchanged: nothing re-made.
    calls.length = 0;
    await macWindowBundle({ runtimeDir: runtime, app, root, run });
    assertEquals(calls, []);
    // The app's identity changed (an update renamed it): re-made.
    await Deno.writeTextFile(
      join(app, "Contents", "Info.plist"),
      `<plist><dict><key>CFBundleName</key><string>Notes 2</string><key>CFBundleIdentifier</key><string>app.aio.notes</string></dict></plist>`,
    );
    await macWindowBundle({ runtimeDir: runtime, app, root, run });
    assert(calls.length > 0);
    // A signing failure is a thrown reason, never a bundle that looks done.
    await Deno.writeTextFile(
      join(app, "Contents", "Info.plist"),
      `<plist><dict><key>CFBundleIdentifier</key><string>app.aio.notes</string><key>CFBundleName</key><string>N3</string></dict></plist>`,
    );
    await assertRejects(
      () =>
        macWindowBundle({
          runtimeDir: runtime,
          app,
          root,
          run: async (cmd, args) =>
            cmd.endsWith("codesign")
              ? { ok: false, stderr: "errSecInternalComponent" }
              : await run(cmd, args),
        }),
      Error,
      "could not sign",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

async function copyTree(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true });
  for await (const e of Deno.readDir(src)) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory) await copyTree(s, d);
    else await Deno.copyFile(s, d);
  }
}

Deno.test("ensureSharedElectron: a runtime already in the store is found without a request", async () => {
  const tmp = await tempDir("shared-ensure-");
  try {
    const rel = await release(await runtimeZip(tmp));
    const root = join(tmp, "s");
    await ensureSharedElectron(V, SLUG, {
      root,
      fetch: rel.fetch,
      log: () => {},
    });
    await ensureSharedElectron(V, SLUG, {
      root,
      fetch: rel.fetch,
      log: () => {},
    });
    assertEquals(rel.state.zipFetches, 1);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("dialog: zenity/yad text is Pango markup — escaped; how a helper ended decides cancel vs lost", () => {
  assertEquals(pangoText("R&D <beta>"), "R&amp;D &lt;beta&gt;");
  assertEquals(zenityEnding(1, ""), { cancelled: true });
  assertEquals(zenityEnding(1, "Gtk-WARNING **: x"), { cancelled: true });
  assertEquals(zenityEnding(0, ""), { cancelled: true });
  assertEquals(
    zenityEnding(1, "Gtk-WARNING: x\ncannot open display: :0"),
    { lost: "cannot open display: :0" },
  );
  assertEquals(zenityEnding(-1, ""), { lost: "exited -1" });
  assertEquals(zenityEnding(134, "Aborted"), { lost: "Aborted" });
});

Deno.test("dialog: each helper closes itself once the app's process is gone — by pid, so a machine that slept is not a death", () => {
  assertStringIncludes(
    WINDOWS_PROGRESS_PS,
    "Get-Process -Id ([int]$env:AIO_DLG_PARENT)",
  );
  assertStringIncludes(MAC_PROGRESS_JXA, "'/bin/kill', ['-0', parent]");
  assert(
    !/LastWriteTime|fileModificationDate/.test(
      WINDOWS_PROGRESS_PS + MAC_PROGRESS_JXA,
    ),
  );
});

Deno.test("dialog: macOS — a minimized or hidden progress window is not a cancel", () => {
  assertStringIncludes(
    MAC_PROGRESS_JXA,
    "!win.isVisible && !win.isMiniaturized && !app.isHidden",
  );
});

Deno.test("dialog: a browser page that cannot be opened, or never loads, is a lost window — and its question answers Quit", async () => {
  // Refused (no browser, $AIO_NO_OPEN, …).
  const refused = browserBackend(() => Promise.reject(new Error("no browser")));
  const d = await refused.progress("T", "H");
  assertStringIncludes(await d.lost, "no browser");
  await d.close();
  assertEquals(await refused.ask("T", "failed"), "quit");
  // Opened, but the page never asked for its state.
  const silent = browserBackend(() => Promise.resolve(), 200);
  const s = await silent.progress("T", "H");
  assertStringIncludes(await s.lost, "did not load");
  await s.close();
  // Opened and loaded: not lost.
  const real = browserBackend(async (url) => {
    await (await fetch(url.replace(/\/$/, "/state"))).body?.cancel();
  }, 2000);
  const ok = await real.progress("T", "H");
  const r = await Promise.race([
    ok.lost.then(() => "lost"),
    new Promise((res) => setTimeout(() => res("open"), 500)),
  ]);
  assertEquals(r, "open");
  await ok.close();
});

Deno.test("dialog: a helper gone AFTER its window showed is a cancel; gone BEFORE, the window was lost — the start goes on", async () => {
  for (const shownFirst of [true, false]) {
    const dir = await tempDir("aio-dlg-test-");
    const ack = join(dir, "shown");
    if (shownFirst) await Deno.writeTextFile(ack, "shown");
    let alive = true;
    const d = _fileProgress(join(dir, "p"), dir, ack, () => alive, () => {});
    alive = false;
    const r = await Promise.race([
      d.cancelled.then(() => "cancelled"),
      d.lost.then(() => "lost"),
    ]);
    assertEquals(r, shownFirst ? "cancelled" : "lost");
    await d.close();
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "dialog: zenity's Cancel is a cancel; a zenity that cannot open its window is lost",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    const { dialogBackend } = await import("../src/electron/runtime-dialog.ts");
    const tmp = await tempDir("dlg-zenity-");
    const path = Deno.env.get("PATH");
    const display = Deno.env.get("DISPLAY");
    const wayland = Deno.env.get("WAYLAND_DISPLAY");
    try {
      Deno.env.set("PATH", tmp);
      // A display that is not there: GTK cannot draw, zenity takes over.
      Deno.env.set("DISPLAY", ":98");
      Deno.env.set("WAYLAND_DISPLAY", "");
      const fake = join(tmp, "zenity");
      for (
        const [body, want] of [
          ["/bin/cat >/dev/null & /bin/sleep 0.3; exit 1", "cancelled"],
          // GTK chatter on stderr, then Cancel: still a cancel.
          [
            "echo 'Gtk-WARNING: theme parsing error' >&2; /bin/sleep 0.3; exit 1",
            "cancelled",
          ],
          ["echo 'cannot open display' >&2; exit 1", "lost"],
        ] as const
      ) {
        await Deno.writeTextFile(fake, `#!/bin/sh\n${body}\n`);
        await Deno.chmod(fake, 0o755);
        const said: string[] = [];
        const b = await dialogBackend({ log: (m) => said.push(m) });
        assertEquals(b?.name, "gtk");
        const d = await b!.progress("T", "H");
        const r = await Promise.race([
          d.cancelled.then(() => "cancelled"),
          d.lost.then(() => "lost"),
        ]);
        assertEquals(r, want);
        await d.close();
        assertStringIncludes(said.join("\n"), "zenity draws it instead");
      }
    } finally {
      if (path === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", path);
      if (display === undefined) Deno.env.delete("DISPLAY");
      else Deno.env.set("DISPLAY", display);
      if (wayland === undefined) Deno.env.delete("WAYLAND_DISPLAY");
      else Deno.env.set("WAYLAND_DISPLAY", wayland);
      await dropTempDir(tmp);
    }
  },
});

// ── "Start the previous version" ───────────────────────────────────────────

Deno.test("shared start: with the version an update replaced still kept, the failure question offers Start the previous version — chosen, it starts in this one's place and the start ends", async () => {
  const tmp = await tempDir("shared-previous-");
  try {
    const rel = await release(await runtimeZip(tmp));
    rel.state.fail = true;
    const root = join(tmp, "store");
    const offered: Array<string | undefined> = [];
    const answer = (a: RetryAnswer): DialogBackend => ({
      ...fakeDialog().backend,
      ask: (_t, _m, previous) => {
        offered.push(previous);
        return Promise.resolve(a);
      },
    });
    const start = (dialog: DialogBackend, previous?: () => Promise<boolean>) =>
      sharedRuntimeForStart({
        version: V,
        slug: SLUG,
        execPath: join(tmp, "app"),
        title: "Notes",
        log: quiet,
        root,
        fetch: rel.fetch,
        dialog,
        previous,
      });
    // Nothing kept: two buttons.
    assertEquals(await start(answer("quit")), null);
    assertEquals(offered, [undefined]);
    // Kept: the third, and choosing it hands over.
    let handed = 0;
    assertEquals(
      await start(answer("previous"), () => Promise.resolve(++handed > 0)),
      null,
    );
    assertEquals(offered[1], PREVIOUS_ANSWER);
    assertEquals(handed, 1);
    assertEquals(await sharedElectronReady(V, SLUG, root), false);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("dialog: the third answer on every backend — Windows Yes/No/Cancel with the text saying which, Cocoa's button, zenity's extra button, yad's code, the browser page's button", async () => {
  // Windows: aio's own form, its buttons named.
  assertEquals(
    ["retry", "previous", "quit", ""].map(windowsAnswer),
    ["retry", "previous", "quit", "quit"],
  );
  assertStringIncludes(WINDOWS_ASK_PS, "$env:AIO_DLG_PREVIOUS");
  // macOS: aio's own window, its third button when given.
  assertStringIncludes(MAC_ASK_JXA, "const previous = argv[3] || '';");
  assertEquals(macAnswer("Retry\n", PREVIOUS_ANSWER), "retry");
  assertEquals(macAnswer(PREVIOUS_ANSWER, PREVIOUS_ANSWER), "previous");
  assertEquals(macAnswer(PREVIOUS_ANSWER), "quit");
  // zenity / yad.
  assert(
    !zenityAskArgs("zenity", "T", "m").some((a) => a.startsWith("--extra")),
  );
  assert(
    zenityAskArgs("zenity", "T", "m", PREVIOUS_ANSWER).includes(
      `--extra-button=${PREVIOUS_ANSWER}`,
    ),
  );
  assert(
    zenityAskArgs("yad", "T", "m", PREVIOUS_ANSWER).includes(
      `--button=${PREVIOUS_ANSWER}:2`,
    ),
  );
  assertEquals(zenityAnswer("zenity", 0, "", PREVIOUS_ANSWER), "retry");
  assertEquals(
    zenityAnswer("zenity", 1, `${PREVIOUS_ANSWER}\n`, PREVIOUS_ANSWER),
    "previous",
  );
  assertEquals(zenityAnswer("zenity", 1, "", PREVIOUS_ANSWER), "quit");
  assertEquals(zenityAnswer("yad", 2, "", PREVIOUS_ANSWER), "previous");
  assertEquals(zenityAnswer("yad", 2, ""), "quit");
  // The browser page: a hidden button, shown with its label while offered.
  assertStringIncludes(browserPage("T"), "/answer?previous");
  let page = "";
  const b = browserBackend(async (url) => {
    page = url;
    await (await fetch(`${url}state`)).body?.cancel();
  }, 2000);
  const asked = b.ask("T", "failed", PREVIOUS_ANSWER);
  for (let i = 0; i < 50 && !page; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const st = await (await fetch(`${page}state`)).json();
  assertEquals(st.previous, PREVIOUS_ANSWER);
  await (await fetch(`${page}answer?previous`, { method: "POST" })).body
    ?.cancel();
  assertEquals(await asked, "previous");
});

// ── the default download window: the app's look, its words, Cancel only ──

Deno.test('dialog: the download window\'s words — "Getting <title> ready", what comes down, that later starts skip it, how far', () => {
  assertEquals(readyHeading("Notes"), "Getting Notes ready");
  assertEquals(
    downloadDetail("44.9.0", 22e6, 123e6),
    "Downloading Electron 44.9.0 — first start only · 22 / 123 MB",
  );
});

Deno.test("dialog: the default download window and the question wear the app's identity colours — the splash's defaults exactly, one mode string per OS mode", () => {
  const c = identityDialogColors("com.example.notes");
  // The very colours a build.splash with no colours set draws with.
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
    ),
    (ch) => ch.charCodeAt(0),
  );
  // (Text below the image, on the strip: the text over it takes the colour
  // that reads on the image instead.)
  const r = resolveSplash({
    build: { splash: { image: "s.png", textPosition: "below" } },
  }, {
    root: "/p",
    appId: "com.example.notes",
    read: () => png,
  });
  if ("error" in r) throw new Error(r.error);
  assertEquals(c, { light: r.splash!.light, dark: r.splash!.dark });
  assert(c.light.background !== c.dark.background, "light and dark differ");
  assertEquals(
    lookArg(c.light),
    `${c.light.background} ${c.light.text} ${c.light.bar} ${c.light.track}`,
  );
  assertEquals(lookArg(undefined), "", "none: the system's look");
});

Deno.test("dialog: Windows — the download window and the question take the colours by the app mode Windows is in; a bar of the app's colours; Cancel the one button", () => {
  for (const ps of [WINDOWS_PROGRESS_PS, WINDOWS_ASK_PS]) {
    assertStringIncludes(ps, "$env:AIO_DLG_LIGHT");
    assertStringIncludes(ps, "$env:AIO_DLG_DARK");
    assertStringIncludes(ps, "AppsUseLightTheme");
    assertStringIncludes(ps, "$f.BackColor = $bg");
    assertStringIncludes(ps, "AioButton $");
  }
  // Windows Forms' own bar takes no colours: aio's track and fill.
  assert(!WINDOWS_PROGRESS_PS.includes("Forms.ProgressBar"));
  assertStringIncludes(WINDOWS_PROGRESS_PS, "$fl.BackColor");
  // One button, Cancel — the cancel (exit 3), as the close is.
  assertEquals(
    WINDOWS_PROGRESS_PS.match(/Forms\.Button\b/g)?.length,
    1,
  );
  assertStringIncludes(WINDOWS_PROGRESS_PS, "$c.Text = 'Cancel'");
  assertStringIncludes(WINDOWS_PROGRESS_PS, "$f.CancelButton = $c");
  assertStringIncludes(WINDOWS_PROGRESS_PS, "exit 3");
  assert(!/'OK'/.test(WINDOWS_PROGRESS_PS));
});

Deno.test("dialog: macOS — the download window and the question take the colours by macOS's mode; a bar of the app's colours; Cancel the one button", () => {
  for (const js of [MAC_PROGRESS_JXA, MAC_ASK_JXA]) {
    assertStringIncludes(js, MAC_LOOK_JS);
    assertStringIncludes(js, "win.backgroundColor = look.bg");
  }
  assertStringIncludes(
    MAC_PROGRESS_JXA,
    "aioLook(argv[7] || '', argv[8] || '')",
  );
  assertStringIncludes(MAC_ASK_JXA, "aioLook(argv[4] || '', argv[5] || '')");
  assert(!MAC_PROGRESS_JXA.includes("NSProgressIndicator"));
  assertEquals(MAC_PROGRESS_JXA.match(/\$\.NSButton\.alloc/g)?.length, 1);
  assertStringIncludes(MAC_PROGRESS_JXA, "cancel.title = 'Cancel'");
  assertStringIncludes(
    MAC_PROGRESS_JXA,
    "if (Number(cancel.state) === 1) $.exit(3);",
  );
  // aioLook picks the mode macOS is in, the colours as given.
  const made: number[][] = [];
  const fake = (style: string | null) => ({
    NSUserDefaults: {
      standardUserDefaults: {
        stringForKey: () =>
          style === null ? null : { isNil: () => false, js: style },
      },
    },
    NSColor: {
      colorWithSRGBRedGreenBlueAlpha: (r: number, g: number, b: number) => {
        made.push([r, g, b].map((v) => Math.round(v * 255)));
        return made.length - 1;
      },
    },
  });
  const look = (style: string | null, l: string, d: string) =>
    new Function("$", MAC_LOOK_JS + "\nreturn aioLook;")(fake(style))(l, d);
  assertEquals(look(null, "", ""), null, "none: the system's look");
  const L = "#ffffff #000000 #ff0000 #00ff00";
  const D = "#101010 #f0f0f0 #0000ff #202020";
  made.length = 0;
  assertEquals(look("Dark", L, D).isDark, true);
  assertEquals(made, [[16, 16, 16], [240, 240, 240], [0, 0, 255], [
    32,
    32,
    32,
  ]]);
  made.length = 0;
  assertEquals(look(null, L, D).isDark, false);
  assertEquals(made[0], [255, 255, 255]);
});

Deno.test("dialog: yad's download window has Cancel as its one button; zenity cannot drop its OK (said in the docs)", () => {
  const yad = zenityProgressArgs("yad", "Notes", readyHeading("Notes"));
  assertEquals(yad.filter((a) => a.startsWith("--button")), [
    "--button=Cancel:1",
  ]);
  assertEquals(zenityEnding(1, ""), { cancelled: true }, "Cancel is exit 1");
  assert(
    !zenityProgressArgs("zenity", "Notes", "H").some((a) =>
      a.startsWith("--button")
    ),
  );
  assertStringIncludes(yad.join(" "), "--text=Getting Notes ready");
});

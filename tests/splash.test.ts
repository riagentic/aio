// build.splash — the native splash: the resolver, the pure lifetime, the
// helpers' scripts and arguments, the session, and the launch under it.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import { resolveSplash, SPLASH_MAX_BYTES } from "../src/build/splash.ts";
import { appIdentityColors } from "../src/build/app-theme.ts";
import {
  bakedSplash,
  BAR_PT,
  SPLASH_CAP_MS,
  type SplashEvent,
  splashOpened,
  type SplashSpec,
  type SplashState,
  splashStep,
  splashText,
} from "../src/electron/splash.ts";
import {
  linuxSplash,
  MAC_PROGRESS_JXA,
  MAC_SPLASH_JXA,
  macSplashArgs,
  type ProgressDialog,
  splashBackend,
  type SplashOpener,
  WINDOWS_SPLASH_PS,
  windowsSplashEnv,
  yadSplash,
} from "../src/electron/runtime-dialog.ts";
import { splashSession } from "../src/electron/splash-session.ts";
import {
  forwardStderr,
  runUnderSplash,
  splashHoldCapMs,
} from "../src/electron/electron-spawn.ts";
import { tmplSplashHold } from "../src/electron/electron-shared.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import {
  formatRendererLine,
  mountLine,
} from "../src/electron/electron-renderer-log.ts";
import { sharedRuntimeForStart } from "../src/electron/shared-runtime.ts";
import { ELECTRON_VERSION_FILE } from "../src/electron/electron-runtime-fetch.ts";
import { VALID_BUILD_KEYS } from "../src/server/config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A PNG header pngSize reads: signature + IHDR with w × h. */
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

const files: Record<string, Uint8Array> = {
  "/p/assets/splash.png": png(480, 300),
  "/p/assets/splash@2x.png": png(960, 600),
  "/p/assets/big.png": png(10, 10, SPLASH_MAX_BYTES),
  "/p/assets/not.png": new TextEncoder().encode("GIF89a……………………………………"),
};
const ctx = {
  root: "/p",
  appId: "com.example.notes",
  // The resolver resolves with the host's rules: `C:\p\assets\…` on Windows.
  read: (p: string) =>
    files[p.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/")] ?? null,
};
const resolveOf = (splash: unknown) =>
  resolveSplash({ build: { splash } }, ctx);
const spec = (splash: unknown): SplashSpec => {
  const r = resolveOf(splash);
  if ("error" in r) throw new Error(r.error);
  return r.splash!;
};
const err = (splash: unknown): string => {
  const r = resolveOf(splash);
  assert("error" in r, `expected a refusal for ${JSON.stringify(splash)}`);
  return r.error;
};

// ── the config ─────────────────────────────────────────────────────────────

Deno.test("splash config: absent or false is none; the image alone takes every default from the app's identity", () => {
  assertEquals(resolveSplash({}, ctx), { splash: null });
  assertEquals(resolveOf(false), { splash: null });
  assert(VALID_BUILD_KEYS.has("splash"));
  assert(!VALID_BUILD_KEYS.has("startWindow"));
  const s = spec({ image: "assets/splash.png" });
  const id = appIdentityColors(ctx.appId);
  assertEquals(s.image.w, 480);
  assertEquals(s.image.h, 300);
  assertEquals(s.image.scale, 1);
  assertEquals(s.text, null);
  assertEquals(s.progress, false);
  assertEquals(s.minMs, 1000);
  assertEquals(s.font, { family: null, size: 13, weight: "bold" });
  assertEquals(s.bar, "solid");
  assertEquals(s.light, {
    background: id.light.background,
    text: id.light.text,
    bar: id.light.accent,
    track: id.light.track,
  });
  assertEquals(s.dark.text, id.dark.text);
  assertEquals(
    atob(s.image.png).length,
    files["/p/assets/splash.png"]!.length,
  );
});

Deno.test("splash config: an @2x image is drawn at half its pixels; set colours are the same in both modes", () => {
  const s = spec({
    image: "assets/splash@2x.png",
    text: "Starting {title}…",
    progress: true,
    minMs: 0,
    font: { family: "Georgia", size: 18, weight: "normal" },
    color: "#ffffff",
    bar: { style: "thin", color: "#ff0000", track: "#000000" },
  });
  assertEquals(s.image.scale, 2);
  assertEquals(s.text, "Starting {title}…");
  assertEquals(s.minMs, 0);
  assertEquals(s.font, { family: "Georgia", size: 18, weight: "normal" });
  assertEquals(s.bar, "thin");
  for (const m of [s.light, s.dark]) {
    assertEquals([m.text, m.bar, m.track], ["#ffffff", "#ff0000", "#000000"]);
  }
  assertEquals(spec({ image: "assets/splash.png", text: false }).text, null);
});

Deno.test("splash config: every bad value is refused by its key, with the fix", () => {
  const img = "assets/splash.png";
  assertStringIncludes(err(true), "must be false (no splash) or");
  assertStringIncludes(err({}), "build.splash.image is undefined");
  assertStringIncludes(err({ image: "nope.png" }), "which is not there");
  assertStringIncludes(err({ image: "assets/not.png" }), "is not a PNG");
  assertStringIncludes(err({ image: "assets/big.png" }), "under 1 MB");
  assertStringIncludes(
    err({ image: img, heading: "x" }),
    "build.splash.heading is not a key aio reads",
  );
  assertStringIncludes(err({ image: img, text: "" }), "non-empty string");
  assertStringIncludes(err({ image: img, text: "{name}" }), "{name}");
  assertStringIncludes(err({ image: img, progress: 1 }), "progress is 1");
  assertStringIncludes(err({ image: img, minMs: -1 }), "0 to 10000");
  assertStringIncludes(err({ image: img, minMs: 1.5 }), "0 to 10000");
  assertStringIncludes(err({ image: img, color: "red" }), '"#rrggbb"');
  assertStringIncludes(err({ image: img, font: { size: 4 } }), "8 to 48");
  assertStringIncludes(err({ image: img, font: { weight: 700 } }), '"bold"');
  assertStringIncludes(
    err({ image: img, font: { family: "" } }),
    "font.family",
  );
  assertStringIncludes(err({ image: img, font: { x: 1 } }), "font.x");
  assertStringIncludes(err({ image: img, bar: { style: "fat" } }), '"thin"');
  assertStringIncludes(
    err({ image: img, bar: { color: "#fff" } }),
    "bar.color",
  );
  assertStringIncludes(err({ image: img, bar: { x: 1 } }), "bar.x");
});

Deno.test("splash text: the placeholders, MB, and ? while the size is unknown", () => {
  assertEquals(splashText("Starting {title}…", "Notes"), "Starting Notes…");
  assertEquals(
    splashText("{got} / {total} MB ({pct}%)", "N", 45e6, 110e6),
    "45 / 110 MB (40%)",
  );
  assertEquals(splashText("{got} / {total} ({pct})", "N", 5e6, 0), "5 / ? (?)");
  // A key on Object.prototype is not a placeholder.
  assertEquals(splashText("{constructor}", "N"), "{constructor}");
});

// ── the lifetime ───────────────────────────────────────────────────────────

const O = { minMs: 1000, capMs: 30_000 };
const run = (events: SplashEvent[], s: SplashState = splashOpened(0)) =>
  events.reduce((st, e) => splashStep(st, e, O), s);

const at = (s: SplashState) => [s.closed, s.showMain] as const;

Deno.test("splash lifetime: ready after minMs — the splash goes and the main window shows at ready", () => {
  assertEquals(
    at(run([{ type: "shown", at: 100 }, { type: "ready", at: 1200 }])),
    ["ready", true],
  );
});

Deno.test("splash lifetime: ready before minMs — the main window waits, and shows as the splash goes at minMs after it APPEARED", () => {
  const early = run([{ type: "shown", at: 100 }, { type: "ready", at: 300 }]);
  assertEquals(at(early), [null, false]);
  assertEquals(at(run([{ type: "tick", at: 1099 }], early)), [null, false]);
  assertEquals(at(run([{ type: "tick", at: 1100 }], early)), ["ready", true]);
});

Deno.test("splash lifetime: ready before the splash is visible — it still shows, for minMs, and the main window waits for it", () => {
  const s = run([{ type: "ready", at: 10 }, { type: "tick", at: 500 }]);
  assertEquals(at(s), [null, false]);
  const up = run([{ type: "shown", at: 650 }, { type: "tick", at: 1649 }], s);
  assertEquals(at(up), [null, false]);
  assertEquals(at(run([{ type: "tick", at: 1650 }], up)), ["ready", true]);
});

Deno.test("splash lifetime: a lost helper (never visible) — the main window shows at ready, before or after it was lost", () => {
  assertEquals(
    at(run([{ type: "lost" }, { type: "ready", at: 300 }])),
    ["lost", true],
  );
  assertEquals(
    at(run([{ type: "ready", at: 300 }, { type: "lost" }])),
    ["lost", true],
  );
  assertEquals(at(run([{ type: "lost" }])), ["lost", false]);
});

Deno.test("splash lifetime: exit, shutdown, a dismissal, a failed download and a lost helper close it at once; a closed one stays closed", () => {
  for (
    const t of ["exit", "shutdown", "dismissed", "failed", "lost"] as const
  ) {
    const s = run([{ type: "shown", at: 0 }, { type: t }]);
    assertEquals(at(s), [t, false]);
    // …and the window, when it is ready, is not held for a splash that went.
    assertEquals(at(run([{ type: "ready", at: 5000 }], s)), [t, true]);
  }
});

Deno.test("splash lifetime: the cap closes it without a ready signal, never during a download, and counts from the download's end", () => {
  assertEquals(run([{ type: "tick", at: 29_999 }]).closed, null);
  assertEquals(run([{ type: "tick", at: 30_000 }]).closed, "cap");
  const dl = run([
    { type: "shown", at: 0 },
    { type: "download", on: true, at: 10 },
    { type: "tick", at: 120_000 },
  ]);
  assertEquals(dl.closed, null);
  const after = run([{ type: "download", on: false, at: 120_000 }], dl);
  assertEquals(run([{ type: "tick", at: 149_999 }], after).closed, null);
  assertEquals(run([{ type: "tick", at: 150_000 }], after).closed, "cap");
  assertEquals(SPLASH_CAP_MS, 30_000);
  // A ready signal after the cap shows the window at once.
  const capped = run([{ type: "tick", at: 30_000 }]);
  assertEquals(at(capped), ["cap", false]);
  assertEquals(at(run([{ type: "ready", at: 31_000 }], capped)), ["cap", true]);
});

Deno.test("splash hold: the hidden main window shows by itself minMs + 5 s after ready-to-show — a splash that never says so never hides the app", () => {
  assertEquals(splashHoldCapMs(1000), 6000);
  assertEquals(splashHoldCapMs(0), 5000);
  const { before, after } = tmplSplashHold();
  assertStringIncludes(
    before,
    "if (process.env.AIO_SPLASH_SHOW) b.show = false;",
  );
  for (
    const k of [
      "process.env.AIO_SPLASH_CAP_MS",
      "win.once('ready-to-show'",
      "existsSync(__aioHoldFile)",
      "win.show()",
    ]
  ) assertStringIncludes(after, k);
  // Both shells hold their window, before it is made and after.
  for (
    const src of [
      electronMainScript("http://127.0.0.1:1/"),
      electronMainScriptUDS("aio://app/", "/tmp/x.sock", {}),
    ]
  ) {
    new Function("require", "process", src); // parses
    const made = src.indexOf("const win = new BrowserWindow(b);");
    assert(src.indexOf(before) < made && src.indexOf(before) > 0);
    assert(src.indexOf(after) > made);
  }
});

// ── the helpers ────────────────────────────────────────────────────────────

const full = spec({
  image: "assets/splash@2x.png",
  text: "{got} of {total} MB",
  progress: true,
  font: { family: "Georgia", size: 15 },
  bar: { style: "thin" },
});
const plain = spec({ image: "assets/splash.png" });
const a = {
  title: "Notes",
  text: "0 of ? MB",
  image: "/t/splash@2x.png",
  file: "/t/progress",
  ack: "/t/shown",
};

Deno.test("splash helpers: the macOS script parses, reads every argument it is given, and neither JXA script uses registerSubclass (it hangs on macOS 14)", () => {
  new Function(MAC_SPLASH_JXA); // parses
  assert(!MAC_SPLASH_JXA.includes("registerSubclass("));
  assert(!MAC_PROGRESS_JXA.includes("registerSubclass("));
  const argv = macSplashArgs(full, a);
  assertEquals(argv.length, 14);
  assertStringIncludes(MAC_SPLASH_JXA, `argv[${argv.length - 1}]`);
  assertEquals(argv.slice(1, 3), ["0 of ? MB", "1"]);
  assertEquals(argv[9], "2");
  assertEquals(argv[10], "Georgia");
  assertEquals(argv[13], String(BAR_PT.thin));
  assertEquals(macSplashArgs(plain, a)[2], "0");
  assertEquals(macSplashArgs(plain, a)[13], "0"); // no progress → no bar
  for (
    const k of [
      "setActivationPolicy",
      "orderFrontRegardless",
      "alphaValue",
      "NSShadow",
    ]
  ) {
    assertStringIncludes(MAC_SPLASH_JXA, k);
  }
});

Deno.test("splash helpers: the Windows script reads exactly the variables it is given, is borderless, on top, off the taskbar, and fades", () => {
  const env = windowsSplashEnv(full, a);
  const read = new Set(
    [...WINDOWS_SPLASH_PS.matchAll(/\$env:(AIO_SPL_\w+)/g)].map((m) => m[1]!),
  );
  assertEquals([...read].sort(), Object.keys(env).sort());
  assertEquals(env.AIO_SPL_BAR, String(BAR_PT.thin));
  assertEquals(env.AIO_SPL_SCALE, "2");
  assertEquals(windowsSplashEnv(plain, a).AIO_SPL_BAR, "0");
  assertEquals(windowsSplashEnv(plain, a).AIO_SPL_HASTEXT, "0");
  for (
    const k of [
      "FormBorderStyle = 'None'",
      "ShowInTaskbar = $false",
      "TopMost = $true",
      "Opacity",
      "AIO_SPL_ACK",
    ]
  ) assertStringIncludes(WINDOWS_SPLASH_PS, k);
});

Deno.test("splash helpers: a splash closed while its helper was starting is never shown (measured on Windows: a warm start's window loads before PowerShell is up)", () => {
  const ps = WINDOWS_SPLASH_PS;
  const psCheck = ps.indexOf("-eq 'close') { exit 0 }");
  assert(psCheck > 0 && psCheck < ps.indexOf("$f.ShowDialog()"));
  const js = MAC_SPLASH_JXA;
  const jsCheck = js.indexOf("pre.js === 'close') $.exit(0)");
  assert(jsCheck > 0 && jsCheck < js.indexOf("win.orderFrontRegardless"));
});

const pwsh = (() => {
  for (
    const p of (Deno.env.get("PATH") ?? "").split(
      Deno.build.os === "windows" ? ";" : ":",
    )
  ) {
    for (const n of ["pwsh", "pwsh.exe", "powershell.exe"]) {
      try {
        if (Deno.statSync(join(p, n)).isFile) return join(p, n);
      } catch { /* not here */ }
    }
  }
  return null;
})();

Deno.test({
  name: "splash helpers: the Windows script parses (PowerShell's own parser)",
  ignore: !pwsh,
  async fn() {
    const tmp = await tempDir("splash-ps-");
    try {
      const f = join(tmp, "s.ps1");
      await Deno.writeTextFile(f, WINDOWS_SPLASH_PS);
      const out = await new Deno.Command(pwsh!, {
        args: [
          "-NoProfile",
          "-Command",
          `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$null,[ref]$e);$e.Count`,
        ],
        stdout: "piped",
      }).output();
      assertEquals(new TextDecoder().decode(out.stdout).trim(), "0");
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test("splash helpers: yad draws the image above the bar and its text, borderless, on top, off the taskbar — the bar is the download's, else it pulses", () => {
  const y = yadSplash(full, a);
  for (
    const k of [
      "--progress",
      "--image=/t/splash@2x.png",
      "--image-on-top",
      "--undecorated",
      "--no-buttons",
      "--skip-taskbar",
      "--on-top",
      "--center",
      "--percentage=0",
    ]
  ) assert(y.args.includes(k), k);
  // yad 0.40 puts a --text BESIDE the image (measured): the text is the bar's,
  // and the bar's text is plain — markup would be shown as typed.
  assert(!y.args.some((x) => x.startsWith("--text=")));
  assertEquals(y.line(0.5, "a & b\nc"), "49\n# a & b c\n");
  assertEquals(y.line(null, "a & b"), "# a & b\n");
  const p = yadSplash(plain, a);
  assert(p.args.includes("--pulsate"));
  assertEquals(p.line(0.5, "x"), "");
});

Deno.test("splash helpers: Linux says in ONE line what was drawn — yad, zenity text only, or nothing", () => {
  assertEquals(linuxSplash({ yad: true, zenity: true }).use, "yad");
  const z = linuxSplash({ yad: false, zenity: true });
  assertEquals(z.use, "zenity");
  assertStringIncludes(z.note, "text");
  const n = linuxSplash({ yad: false, zenity: false });
  assertEquals(n.use, null);
  assertStringIncludes(n.note, "not shown");
  for (const x of [z, n]) assert(!x.note.includes("\n"));
});

Deno.test({
  name:
    "splash helpers: Linux without yad — a fake zenity is handed a text-only pulsing window, and the text as it changes",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const tmp = await tempDir("splash-zenity-");
    const old = {
      PATH: Deno.env.get("PATH"),
      DISPLAY: Deno.env.get("DISPLAY"),
    };
    try {
      const bin = join(tmp, "zenity");
      await Deno.writeTextFile(
        bin,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${tmp}/args"\ncat > "${tmp}/stdin"\n`,
      );
      await Deno.chmod(bin, 0o755);
      Deno.env.set("PATH", `${tmp}:/usr/bin:/bin`);
      Deno.env.set("DISPLAY", ":99");
      const notes: string[] = [];
      const s = spec({ image: "assets/splash.png", text: "Starting {title}…" });
      const opener = await splashBackend(s, { log: (m) => notes.push(m) });
      assertEquals(opener?.name, "zenity splash");
      assertEquals(notes.length, 1);
      assertStringIncludes(notes[0]!, "yad is not installed");
      const d = await opener!.open("Notes", "Starting Notes…");
      d.update(null, "Starting Notes…");
      await d.close();
      const args = (await Deno.readTextFile(join(tmp, "args"))).split("\n");
      for (
        const k of [
          "--progress",
          "--pulsate",
          "--no-cancel",
          "--text=Starting Notes…",
        ]
      ) {
        assert(args.includes(k), k);
      }
      assertStringIncludes(
        await Deno.readTextFile(join(tmp, "stdin")),
        "# Starting Notes…\n",
      );
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
      await dropTempDir(tmp);
    }
  },
});

// ── the session and the launch ─────────────────────────────────────────────

/** A helper that records what it was told; `show()` puts it on screen. */
function fakeOpener() {
  const seen = {
    opened: [] as string[],
    lines: [] as Array<[number | null, string]>,
    closed: 0,
  };
  let show!: () => void, cancel!: () => void;
  const opener: SplashOpener = {
    name: "fake splash",
    open(title, text) {
      seen.opened.push(`${title} | ${text}`);
      const d: ProgressDialog = {
        update: (f, t) => void seen.lines.push([f, t]),
        shown: new Promise<void>((r) => (show = r)),
        cancelled: new Promise<void>((r) => (cancel = r)),
        lost: new Promise<string>(() => {}),
        close: () => (seen.closed++, Promise.resolve()),
      };
      return Promise.resolve(d);
    },
  };
  return { opener, seen, show: () => show(), cancel: () => cancel() };
}

const tickle = () => new Promise((r) => setTimeout(r, 5));

/** The session's tick is unref'd — a splash never keeps the app alive — so a
 *  test that waits on it alone can see its event loop end first: on Windows's
 *  ~15 ms timer grain the tick is not yet due when the loop checks. Held. */
const held = <T>(p: Promise<T>): Promise<T> => {
  const keep = setInterval(() => {}, 1000);
  return p.finally(() => clearInterval(keep));
};

function session(
  s: SplashSpec,
  f: ReturnType<typeof fakeOpener>,
  clock = { t: 0 },
) {
  const log: string[] = [];
  const shows: number[] = [];
  const ses = splashSession(s, {
    title: "Notes",
    log: { info: (m) => log.push(m), error: (m) => log.push(`! ${m}`) },
    backend: () => Promise.resolve(f.opener),
    now: () => clock.t,
    tickMs: 2,
    onShowMain: () => shows.push(clock.t),
  });
  return { ses, log, clock, shows };
}

Deno.test("splash session: opened with its text, says when it is visible, and holds a ready signal until minMs has passed", async () => {
  const f = fakeOpener();
  const { ses, log, clock, shows } = session(
    spec({ image: "assets/splash.png", text: "Starting {title}…" }),
    f,
  );
  ses.open();
  await tickle();
  assertEquals(f.seen.opened, ["Notes | Starting Notes…"]);
  clock.t = 40;
  f.show();
  await tickle();
  assert(
    log.some((l) => /visible 40 ms after it was asked for/.test(l)),
    log.join("\n"),
  );
  clock.t = 500;
  ses.ready();
  await tickle();
  assertEquals(f.seen.closed, 0);
  assertEquals(shows, []); // the main window waits for minMs
  clock.t = 1040;
  assertEquals(await held(ses.closed), "ready");
  assertEquals(f.seen.closed, 1);
  // Shown once, in the step the splash went — no gap, no overlap.
  assertEquals(shows, [1040]);
  await tickle();
  ses.ready();
  assertEquals(shows, [1040]);
  assert(
    log.some((l) =>
      l.includes("the main window shows 1000 ms after the splash appeared")
    ),
    log.join("\n"),
  );
});

Deno.test("splash session: a download fills the bar and the text; its end hides the bar; a dismissal is the download's cancel", async () => {
  const f = fakeOpener();
  const { ses } = session(full, f);
  ses.open();
  await tickle();
  f.show();
  const d = ses.download()!;
  d.bytes(45e6, 110e6);
  d.update(0.41, "ignored");
  assertEquals(f.seen.lines.at(-1), [0.41, "45 of 110 MB"]);
  await d.close();
  assertEquals(f.seen.lines.at(-1), [null, "45 of 110 MB"]);
  const d2 = ses.download()!;
  f.cancel();
  await d2.cancelled;
  assertEquals(await held(ses.closed), "dismissed");
  assertEquals(ses.download(), null);
});

Deno.test("splash session: no progress → the bar never shows; a failed download closes it before the plain question", async () => {
  const f = fakeOpener();
  const { ses } = session(spec({ image: "assets/splash.png", text: "x" }), f);
  ses.open();
  await tickle();
  ses.download()!.update(0.5, "");
  assertEquals(f.seen.lines.at(-1)![0], null);
  ses.fail();
  assertEquals(await held(ses.closed), "failed");
});

Deno.test("splash session: the cap closes it and says so ONCE", async () => {
  const f = fakeOpener();
  const { ses, log, clock } = session(plain, f);
  ses.open();
  await tickle();
  f.show();
  clock.t = SPLASH_CAP_MS;
  assertEquals(await held(ses.closed), "cap");
  await tickle();
  assertEquals(
    log.filter((l) => l.includes("without the main window's ready signal"))
      .length,
    1,
  );
});

Deno.test("splash session: no helper on this desktop — lost, quietly (the backend's own line said why)", async () => {
  const log: string[] = [];
  const ses = splashSession(plain, {
    title: "N",
    log: { info: (m) => log.push(m), error: (m) => log.push(m) },
    backend: () => Promise.resolve(null),
  });
  ses.open();
  assertEquals(await held(ses.closed), "lost");
  assertEquals(log, []);
});

const fakeProc = () => {
  let exit!: () => void;
  const status = new Promise<Deno.CommandStatus>((r) =>
    exit = () => r({ success: true, code: 0, signal: null })
  );
  return { proc: { status } as Deno.ChildProcess, exit: () => exit() };
};

Deno.test("launch under the splash: the spawn is never held for the window, and the window's ready signal closes it", async () => {
  const f = fakeOpener();
  const { ses, clock } = session(
    spec({ image: "assets/splash.png", minMs: 0 }),
    f,
  );
  const order: string[] = [];
  const opener = f.opener.open;
  f.opener.open = (t, x) => (order.push("splash"), opener(t, x));
  const p = fakeProc();
  let mounted: (() => void) | undefined;
  const proc = await runUnderSplash(ses, undefined, (onMounted) => {
    order.push("spawn");
    mounted = onMounted;
    return Promise.resolve(p.proc);
  });
  assert(proc === p.proc);
  await tickle();
  // The spawn was not held for the window: the helper opened while it ran.
  assertEquals(order, ["spawn", "splash"]);
  clock.t = 10;
  f.show();
  await tickle();
  clock.t = 20;
  mounted!();
  assertEquals(await held(ses.closed), "ready");
  p.exit();
});

Deno.test("launch under the splash: the open is requested before the launch starts", async () => {
  const calls: string[] = [];
  const fake = {
    open: () => calls.push("open"),
    download: () => null,
    ready: () => {},
    exit: () => calls.push("exit"),
    shutdown: () => calls.push("shutdown"),
    fail: () => {},
    closed: new Promise<never>(() => {}),
  };
  const ctl = new AbortController();
  await runUnderSplash(fake, ctl.signal, () => {
    calls.push("launch");
    return Promise.resolve(null);
  });
  assertEquals(calls, ["open", "launch", "exit"]);
  ctl.abort();
  assertEquals(calls.at(-1), "shutdown");
});

Deno.test("launch under the splash: Electron's exit closes it; no splash is the launch alone", async () => {
  const f = fakeOpener();
  const { ses } = session(plain, f);
  const p = fakeProc();
  await runUnderSplash(ses, undefined, () => Promise.resolve(p.proc));
  p.exit();
  assertEquals(await held(ses.closed), "exit");
  let hooked: unknown = "unset";
  await runUnderSplash(null, undefined, (onMounted) => {
    hooked = onMounted;
    return Promise.resolve(null);
  });
  assertEquals(hooked, undefined);
});

Deno.test("launch under the splash: the window's mount line on Electron's stderr is the ready signal — once, and only that line", async () => {
  const lines = [
    formatRendererLine("info", "page loaded"),
    formatRendererLine("info", mountLine(12)),
  ];
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["eval", `console.error(${JSON.stringify(lines.join("\n"))})`],
    stdout: "null",
    stderr: "piped",
  }).spawn();
  let mounted = 0;
  forwardStderr(proc, () => mounted++);
  await proc.status;
  for (let i = 0; i < 50 && mounted === 0; i++) await tickle();
  assertEquals(mounted, 1);
});

Deno.test("splash: an online start's download is shown IN the splash (no plain window), and a failure closes it before the plain Retry / Quit", async () => {
  const tmp = await tempDir("splash-shared-");
  try {
    const calls: string[] = [];
    const handle = {
      update: () => {},
      bytes: () => {},
      cancelled: new Promise<void>(() => {}),
      lost: new Promise<string>(() => {}),
      close: () => (calls.push("download-end"), Promise.resolve()),
    };
    const fake = {
      open: () => {},
      download: () => (calls.push("download"), handle),
      ready: () => {},
      exit: () => {},
      shutdown: () => {},
      fail: () => void calls.push("fail"),
      closed: new Promise<never>(() => {}),
    };
    const exe = await sharedRuntimeForStart({
      version: "9.9.9",
      slug: "linux-x64",
      execPath: join(tmp, "app"),
      title: "Notes",
      log: { info: () => {}, error: () => {} },
      root: join(tmp, "store"),
      sha256: "0".repeat(64),
      fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch,
      dialog: {
        name: "fake",
        progress: () => (
          calls.push("plain-window"), Promise.reject(new Error("x"))
        ),
        ask: () => (calls.push("ask"), Promise.resolve("quit" as const)),
      },
      splash: fake,
    });
    assertEquals(exe, null);
    assertEquals(calls, ["download", "download-end", "fail", "ask"]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("splash session: a helper that dies before its ack ends the download's handle as LOST (not a cancel)", async () => {
  let give!: (o: null) => void;
  const ses = splashSession(plain, {
    title: "N",
    log: { info: () => {}, error: () => {} },
    backend: () => new Promise((r) => (give = r)),
  });
  ses.open();
  const d = ses.download()!; // asked for within ms — the helper has not acked
  assert(d);
  let cancelled = false;
  d.cancelled.then(() => (cancelled = true));
  give(null);
  assertEquals(await held(ses.closed), "lost");
  const why = await Promise.race([
    d.lost,
    tickle().then(() => "still pending"),
  ]);
  assertStringIncludes(why, "never showed");
  await tickle();
  assertEquals(cancelled, false);
});

Deno.test("splash: an online start whose splash is lost mid-download goes on in the plain progress window, carrying what it showed — said once", async () => {
  const tmp = await tempDir("splash-shared-lost-");
  try {
    const calls: string[] = [];
    const updates: Array<[number | null, string]> = [];
    let lose!: (why: string) => void;
    let plainOpen!: () => void;
    const plainOpened = new Promise<void>((r) => (plainOpen = r));
    const handle = {
      update: () => {},
      bytes: () => {},
      cancelled: new Promise<void>(() => {}),
      lost: new Promise<string>((r) => (lose = r)),
      close: () => (calls.push("splash-end"), Promise.resolve()),
    };
    const fake = {
      open: () => {},
      download: () => (calls.push("download"), handle),
      ready: () => {},
      exit: () => {},
      shutdown: () => {},
      fail: () => void calls.push("fail"),
      closed: new Promise<never>(() => {}),
    };
    const errors: string[] = [];
    const exe = await sharedRuntimeForStart({
      version: "9.9.9",
      slug: "linux-x64",
      execPath: join(tmp, "app"),
      title: "Notes",
      log: { info: () => {}, error: (m) => errors.push(m) },
      root: join(tmp, "store"),
      sha256: "0".repeat(64),
      // The download is under way when the helper dies; it fails once the
      // plain window is up (the test's end, not the point).
      fetch: (() => {
        lose("helper exited 4");
        return plainOpened.then(() => Promise.reject(new TypeError("offline")));
      }) as typeof fetch,
      dialog: {
        name: "fake",
        progress: () => {
          calls.push("plain-window");
          plainOpen();
          return Promise.resolve({
            update: (f: number | null, d: string) => void updates.push([f, d]),
            cancelled: new Promise<void>(() => {}),
            lost: new Promise<string>(() => {}),
            close: () => (calls.push("plain-end"), Promise.resolve()),
          });
        },
        ask: () => (calls.push("ask"), Promise.resolve("quit" as const)),
      },
      splash: fake,
    });
    assertEquals(exe, null);
    assertEquals(calls, [
      "download",
      "plain-window",
      "plain-end",
      "fail",
      "ask",
    ]);
    assertEquals(updates[0], [null, "Looking for Electron 9.9.9…"]);
    assertEquals(
      errors.filter((e) => e.includes("splash could not be shown")).length,
      1,
      errors.join("\n"),
    );
    assertStringIncludes(errors.join("\n"), "helper exited 4");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("splash: the main window showing by itself (Electron's cap) closes the splash at once — never both on screen", async () => {
  // Pure: before minMs, before the splash was even visible.
  assertEquals(at(run([{ type: "mainShown" }])), ["ready", true]);
  assertEquals(
    at(run([{ type: "shown", at: 0 }, { type: "mainShown" }])),
    ["ready", true],
  );
  // A splash that already went stays as it went.
  assertEquals(at(run([{ type: "lost" }, { type: "mainShown" }])), [
    "lost",
    false,
  ]);
  // The window side says so through the hold file.
  assertStringIncludes(
    tmplSplashHold().after,
    "writeFileSync(__aioHoldFile, 'shown')",
  );
  // The session polls it: a splash whose ack never came (shownAt null)
  // still goes the moment the window showed.
  const f = fakeOpener();
  let windowShown = false;
  const log: string[] = [];
  const ses = splashSession(plain, {
    title: "Notes",
    log: { info: (m) => log.push(m), error: (m) => log.push(m) },
    backend: () => Promise.resolve(f.opener),
    tickMs: 2,
    mainShown: () => windowShown,
  });
  ses.open();
  await tickle();
  ses.ready();
  await tickle();
  assertEquals(f.seen.closed, 0);
  windowShown = true;
  assertEquals(await held(ses.closed), "ready");
  assertEquals(f.seen.closed, 1);
  assert(log.some((l) => l.includes("showed by itself")), log.join("\n"));
});

Deno.test("splash: the build's record carries it; a record without it (or none) is no splash", async () => {
  const tmp = await tempDir("splash-baked-");
  try {
    assertEquals(await bakedSplash(tmp), null);
    assertEquals(await bakedSplash(undefined), null);
    const f = join(tmp, ELECTRON_VERSION_FILE);
    await Deno.writeTextFile(f, JSON.stringify({ version: "1.0.0" }));
    assertEquals(await bakedSplash(tmp), null);
    await Deno.writeTextFile(
      f,
      JSON.stringify({ version: "1.0.0", splash: plain }),
    );
    assertEquals(await bakedSplash(tmp), plain);
  } finally {
    await dropTempDir(tmp);
  }
});

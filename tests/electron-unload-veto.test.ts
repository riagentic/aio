// jot §8: a page's `beforeunload` veto made the window's ✕ silently dead.
//
// Measured on Electron 44 (nested display): `will-prevent-unload` fires on
// `win.close()` against a page whose beforeunload calls preventDefault — with
// or without a user gesture — and the window stays open with no dialog and no
// line. The default must not flip (an editor shows its own Save / Don't Save),
// so: one warning by default, and `electron.confirmUnload` for the native
// Leave / Stay dialog (preventDefault on Leave, as Electron's docs show).
//
// The fragment is RUN here against a fake `app`/`electron`; the real-Electron
// proof is the ELECTRON_E2E case at the bottom (nested display only).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { tmplCrashGuard } from "../src/electron/electron-shared.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { accountEnv } from "./e2e-app-harness.ts";

type Handler = (...a: unknown[]) => unknown;

/** Run the generated crash guard with fakes; returns a veto driver. */
function runGuard(confirmUnload: boolean, choice = 0, dialogThrows = false) {
  const appH: Record<string, Handler[]> = {};
  const app = {
    on: (e: string, fn: Handler) => (appH[e] ??= []).push(fn),
    quit: () => {},
    exit: () => {},
  };
  const warned: string[] = [];
  const asked: unknown[][] = [];
  const owner = { id: "win" };
  const electron = {
    BrowserWindow: { fromWebContents: () => owner },
    dialog: {
      showMessageBoxSync: (...a: unknown[]) => {
        asked.push(a);
        if (dialogThrows) throw new Error("no display");
        return choice;
      },
    },
  };
  const fakeProcess = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    exit: () => {},
  };
  const fakeConsole = {
    warn: (...a: unknown[]) => warned.push(a.map(String).join(" ")),
    error: (...a: unknown[]) => warned.push(a.map(String).join(" ")),
  };
  const req = (m: string) =>
    m === "electron"
      ? electron
      : m === "util"
      ? { format: (...a: unknown[]) => a.map(String).join(" ") }
      : (() => {
        throw new Error(`unexpected require(${m})`);
      })();
  new Function(
    "app",
    "require",
    "process",
    "console",
    tmplCrashGuard(confirmUnload),
  )(
    app,
    req,
    fakeProcess,
    fakeConsole,
  );
  const wcH: Record<string, Handler> = {};
  const wc = { on: (e: string, fn: Handler) => wcH[e] = fn };
  for (const fn of appH["web-contents-created"] ?? []) fn({}, wc);
  const veto = () => {
    let prevented = false;
    wcH["will-prevent-unload"]!({ preventDefault: () => prevented = true });
    return prevented ? "leaves" : "stays";
  };
  return { veto, warned, asked, owner };
}

Deno.test("unload veto, default: the page keeps its say, and the first veto is said ONCE", () => {
  const g = runGuard(false);
  assertEquals(g.veto(), "stays");
  assertEquals(g.veto(), "stays");
  assertEquals(g.asked, [], "no dialog by default");
  assertEquals(g.warned.length, 1, g.warned.join("\n"));
  assert(g.warned[0]!.includes("confirmUnload"), "the warning names the fix");
});

Deno.test("unload veto, confirmUnload: Leave closes, Stay keeps the page — native, owned dialog", () => {
  const leave = runGuard(true, 0);
  assertEquals(leave.veto(), "leaves");
  assertEquals(leave.asked.length, 1);
  assertEquals(leave.asked[0]![0], leave.owner, "owned by the page's window");
  const o = leave.asked[0]![1] as { buttons: string[]; cancelId: number };
  assertEquals(o.buttons, ["Leave", "Stay"]);
  assertEquals(o.cancelId, 1);
  assertEquals(leave.warned, [], "asking IS the answer — no warning");

  assertEquals(runGuard(true, 1).veto(), "stays");
  const broken = runGuard(true, 0, true);
  assertEquals(
    broken.veto(),
    "stays",
    "a dialog that cannot open keeps the page",
  );
  assertEquals(broken.warned.length, 1);
});

// ── Real Electron (ELECTRON_E2E=1, nested display only) ───────────────────

const ELECTRON_BIN = "node_modules/.bin/electron";
function e2eSkip(): boolean {
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return true;
  }
  return !Deno.env.get("ELECTRON_E2E") || !testDisplayEnv().DISPLAY;
}

async function realVeto(confirm: boolean, choice: number) {
  const dir = await tempDir("aio-unload-");
  try {
    const main = `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, "profile"))});
${tmplCrashGuard(confirm)}
require('electron').dialog.showMessageBoxSync = () => { console.log('M:asked'); return ${choice}; };
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: true, width: 300, height: 200 });
  win.on('closed', () => { console.log('M:closed'); app.exit(0); });
  win.loadURL('data:text/html,<script>addEventListener("beforeunload", (e) => e.preventDefault())</script>x');
  win.webContents.once('did-finish-load', () => {
    win.close();
    setTimeout(() => { console.log('M:still-open'); app.exit(0); }, 1500);
  });
});
`;
    await Deno.writeTextFile(join(dir, "main.cjs"), main);
    const out = await new Deno.Command(ELECTRON_BIN, {
      args: ["--no-sandbox", join(dir, "main.cjs")],
      env: {
        ...Deno.env.toObject(),
        ...testDisplayEnv(),
        HOME: dir,
        // The window's account, never the developer's (its profile is set
        // above too).
        ...accountEnv(),
      },
    }).output();
    return new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "unload veto e2e: a vetoed close stays open and warns; confirmUnload + Leave closes",
  ignore: e2eSkip(),
  async fn() {
    const def = await realVeto(false, 0);
    assert(def.includes("M:still-open"), def);
    assert(def.includes("the page vetoed leaving"), def);
    const leave = await realVeto(true, 0);
    assert(leave.includes("M:asked") && leave.includes("M:closed"), leave);
    assert(!leave.includes("M:still-open"), leave);
    const stay = await realVeto(true, 1);
    assert(stay.includes("M:asked") && stay.includes("M:still-open"), stay);
  },
});

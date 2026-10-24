/**
 * The real-X-driver lane (feedback/critical.md). An aio window placed at the
 * screen edge got its window-manager frame at x = -10 (muffin's invisible
 * border) or grew its own shadow to x = -16 (frameless Electron); an NVIDIA
 * X driver faults on that off-screen rect (Xid 69) and 595 then takes Xorg —
 * the user's whole desktop — down. Xephyr (every other GUI test) never hands
 * a window to the NVIDIA driver, which is why nothing caught it.
 *
 * This boots a real aio app from source as Electron on the GPU lab
 * (scripts/gpu-lab.sh: a second Xorg with the NVIDIA driver on an idle GPU,
 * muffin as its window manager), with the saved window states that took the
 * desktop down, framed and frameless, and records every window the X server
 * sees (scripts/x-blackbox.py). Red on ANY negative coordinate of a window
 * that is ever shown — the client's or its frame — and on any NVIDIA Xid.
 *
 * Runs with AIO_GPU_LAB=1 (release-check passes it when the lab is up);
 * then a lab that is down is a failure, not a skip.
 */
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv } from "./e2e-app-harness.ts";

const ON = Deno.env.get("AIO_GPU_LAB") === "1";
const REPO = join(dirname(fromFileUrl(import.meta.url)), "..");
const LAB = Deno.env.get("AIO_GPU_LAB_DIR") ?? join(REPO, "untracked/gpu-lab");
const NUM = Deno.env.get("AIO_GPU_LAB_DISPLAY") ?? "91";

/** The states three apps had saved when they took X down,
 *  in the lab screen's coordinates (2560×1440, no panel), and two more. */
const STATES = [
  { x: 0, y: 0, width: 2560, height: 1440 },
  { x: 0, y: 0, width: 2560, height: 1440, maximized: true },
  { x: 0, y: 0, width: 800, height: 600 },
  { x: -10, y: -45, width: 900, height: 700 },
];

/** A negative x or y on a window CREATED while the recording ran (the app's
 *  windows and the frames the window manager makes for them — not the
 *  manager's own off-screen helpers, which existed before) that is ever
 *  shown is the finding. */
export function negativeShown(log: string): string[] {
  const mapped = new Set<string>(), created = new Set<string>();
  const rects: { id: string; line: string; x: number; y: number }[] = [];
  for (const line of log.split("\n")) {
    const f = line.split(" ");
    const kind = f[1], id = f[2];
    if (!id) continue;
    if (kind === "create") created.add(id);
    if (kind === "map" || (kind === "have" && / mapped=2 /.test(line))) {
      mapped.add(id);
    }
    // create ID parent=… X,Y … | config ID X,Y … | have ID dN X,Y …
    const at = kind === "create"
      ? f[4]
      : kind === "config"
      ? f[3]
      : kind === "have"
      ? f[4]
      : undefined;
    const m = at?.match(/^(-?\d+),(-?\d+)$/);
    if (m) rects.push({ id, line, x: +m[1]!, y: +m[2]! });
  }
  return rects
    .filter((r) =>
      created.has(r.id) && mapped.has(r.id) && (r.x < 0 || r.y < 0)
    )
    .map((r) => r.line);
}

Deno.test("gpu lab: negativeShown finds the frame muffin put at x = -10, and ignores never-shown helper windows", () => {
  const log = [
    "1.0 create 0xc00002 parent=0x21c -10000,-10000 10x10 or=0",
    "1.1 config 0xc00002 -200,-200 20x20 bw=0 or=0",
    "1.2 create 0x60051a parent=0x21c 0,0 2559x1439 or=0",
    "1.3 map 0x60051a or=0 ",
    "1.4 config 0x60051a -10,-45 2579x1494 bw=0 or=0",
  ].join("\n");
  assertEquals(negativeShown(log), [
    "1.4 config 0x60051a -10,-45 2579x1494 bw=0 or=0",
  ]);
  assertEquals(negativeShown(log.split("\n").slice(0, 4).join("\n")), []);
  // The manager's own helper, there before the app (a `have` line), shown off-screen: not the app's.
  assertEquals(
    negativeShown(
      "1.0 have 0x60000a d1 -200,-200 1x1 or=1 mapped=2 class=muffin/Muffin",
    ),
    [],
  );
});

async function sh(cmd: string[], env: Record<string, string> = {}) {
  const o = await new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(o.stdout);
}

Deno.test({
  name:
    "gpu lab: an aio window — framed and frameless, from every state that took X down — never shows a negative coordinate, and the driver logs no Xid",
  ignore: !ON,
  // aio-ok: real Electron windows, muffin and the X recorder are spawned and stopped per case; their pipes and kill timers outlive a single op's window
  sanitizeResources: false,
  // aio-ok: the same per-case child processes (see sanitizeResources)
  sanitizeOps: false,
  fn: async () => {
    const sock = `/tmp/.X11-unix/X${NUM}`;
    try {
      Deno.statSync(sock);
    } catch {
      throw new Error(
        `AIO_GPU_LAB=1 but the lab display :${NUM} is down — sudo scripts/gpu-lab.sh up (and scripts/gpu-lab.sh desk muffin)`,
      );
    }
    const xenv = { DISPLAY: `:${NUM}`, XAUTHORITY: join(LAB, "Xauthority") };
    // The frame is what lands off-screen, so a window manager must be there:
    // the lab's own (scripts/gpu-lab.sh desk muffin), or one started here for
    // this test and stopped after it — the rest of the suite runs WITHOUT one,
    // as on Xephyr, where its pixel checks were written.
    // The root's _NET_SUPPORTING_WM_CHECK outlives a window manager that was
    // killed: it names a window that is gone. The manager is there only when
    // that window still answers (`wmctrl -m` reads it: "Name: …").
    const hasWm = async () => /^Name: /m.test(await sh(["wmctrl", "-m"], xenv));
    let wm: Deno.ChildProcess | null = null;
    if (!(await hasWm())) {
      const home = join(LAB, "home"); // the desktop's settings, copied (prep)
      // Its own process group (setsid), so stopping it takes muffin and the
      // session bus with it — a signal to dbus-run-session alone leaves
      // muffin running.
      wm = new Deno.Command("setsid", {
        args: ["dbus-run-session", "--", "muffin", "--replace"],
        env: {
          ...xenv,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_CACHE_HOME: join(home, ".cache"),
        },
        stdout: "null",
        stderr: "null",
      }).spawn();
      for (let i = 0; i < 40 && !(await hasWm()); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert(
      await hasWm(),
      "no window manager on the lab display (muffin did not start)",
    );
    const since = Math.floor(Date.now() / 1000);
    const dir = await tempDir("gpu-lab-bounds");
    try {
      // The counter example, with aio's import map made absolute.
      const app = join(dir, "app");
      await Deno.mkdir(join(app, "src"), { recursive: true });
      const cfg = JSON.parse(
        await Deno.readTextFile(join(REPO, "examples/counter/deno.json")),
      );
      cfg.title = "gpu-lab-probe";
      for (
        const [k, v] of Object.entries(cfg.imports as Record<string, string>)
      ) {
        if (v.startsWith("../../")) {
          cfg.imports[k] = "file://" + join(REPO, v.slice(6));
        }
      }
      delete cfg.nodeModulesDir;
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify(cfg, null, 2),
      );
      for (const f of ["cell.ts", "App.tsx"]) {
        await Deno.copyFile(
          join(REPO, "examples/counter/src", f),
          join(app, "src", f),
        );
      }
      await Deno.writeTextFile(
        join(app, "src/app.ts"),
        `import "./cell.ts";\nimport { aio } from "aio";\n` +
          `await aio.run({ ui: { chrome: (Deno.env.get("PROBE_CHROME") ?? "standard") as "standard" } });\n`,
      );
      // The app's home and its window's profile in this test's own folder.
      const apps = join(dir, "apps");
      const runEnv = {
        ...Deno.env.toObject(),
        ...childEnv({
          ...xenv,
          AIO_APPS_DIR: apps,
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_RUNTIME_DIR: join(dir, "run"),
        }),
      };
      await Deno.mkdir(join(dir, "run"), { recursive: true, mode: 0o700 });
      delete (runEnv as Record<string, string>).WAYLAND_DISPLAY;

      const title = "gpu-lab-probe";
      const wm = (...a: string[]) => sh(["wmctrl", ...a], xenv);
      const once = async (chrome: string, state: object | null) => {
        if (state) {
          await Deno.writeTextFile(
            join(apps, title, "electron", "window-state.json"),
            JSON.stringify({
              ...state,
              declaredWidth: 800,
              declaredHeight: 600,
            }),
          );
        }
        const rec = join(dir, `x-${chrome}-${Date.now()}.log`);
        const blackbox = new Deno.Command("python3", {
          args: ["-I", join(REPO, "scripts/x-blackbox.py"), rec],
          env: xenv,
          stdout: "null",
          stderr: "null",
        }).spawn();
        await new Promise((r) => setTimeout(r, 500));
        const child = new Deno.Command("deno", {
          args: ["run", "-A", "src/app.ts", "--client=electron"],
          cwd: app,
          env: { ...runEnv, PROBE_CHROME: chrome },
          stdout: "null",
          stderr: "null",
        }).spawn();
        let shown = false;
        for (let i = 0; i < 120 && !shown; i++) {
          await new Promise((r) => setTimeout(r, 500));
          shown = (await wm("-l")).includes(title);
        }
        await new Promise((r) => setTimeout(r, 2000));
        await wm("-c", title);
        const exit = await Promise.race([
          child.status,
          new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
        ]);
        if (exit === null) child.kill("SIGKILL");
        blackbox.kill("SIGTERM");
        await blackbox.status;
        assert(
          shown,
          `${chrome} ${JSON.stringify(state)}: the window never showed`,
        );
        return negativeShown(await Deno.readTextFile(rec));
      };

      await once("standard", null); // aio makes the app's data dir
      const found: string[] = [];
      for (const chrome of ["standard", "none", "themed"]) {
        for (const s of STATES) {
          for (const line of await once(chrome, s)) {
            found.push(`${chrome} ${JSON.stringify(s)}: ${line}`);
          }
        }
      }
      assertEquals(found, [], "a window aio showed had a negative coordinate");
      const xids =
        (await sh(["journalctl", "-k", "--since", `@${since}`, "--no-pager"]))
          .split("\n").filter((l) => /NVRM: Xid|segfault/.test(l));
      assertEquals(
        xids,
        [],
        "the NVIDIA driver logged an error while aio windows opened",
      );
    } finally {
      await dropTempDir(dir);
      if (wm) {
        await new Deno.Command("kill", { args: ["-TERM", "--", `-${wm.pid}`] })
          .output();
        await wm.status;
      }
    }
  },
});

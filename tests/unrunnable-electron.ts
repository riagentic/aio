// ELECTRON_PATH for an in-process `client: "electron"` app that must open NO
// window, on any OS.
//
// Linux says "no window" by an unset DISPLAY/WAYLAND_DISPLAY (no launch at
// all). macOS and Windows always have a desktop, so the launch goes ahead
// there — and the `/bin/false` stand-in these tests used does not exist on
// either, so findElectronBin went on to the runtime cache: a REAL window when
// one is cached, else a ~100 MB download that outlived the test (measured on
// macOS 14: the sanitizers' fetch + 2 intervals). A file that EXISTS but the
// OS refuses to execute ends the launch at the spawn instead — logged, and a
// dev app keeps serving (the same file tests/electron-main-script-litter
// measured on macOS).
import { join } from "@std/path";

/** Writes the not-runnable stand-in into `dir` and returns its path. */
export async function unrunnableElectron(dir: string): Promise<string> {
  // Not `electron`: that name in an app's home is the window's profile dir.
  const p = join(dir, `unrunnable${Deno.build.os === "windows" ? ".exe" : ""}`);
  await Deno.writeTextFile(p, "not a program");
  if (Deno.build.os !== "windows") await Deno.chmod(p, 0o644);
  return p;
}

import { join } from "@std/path";

// The REAL module cache, for a child spawned with a throwaway HOME.
//
// Without DENO_DIR a child resolves its cache under $HOME, so every run
// re-downloaded each jsr/npm module into an empty temp dir: seconds per spawn,
// network-dependent, and under the mutation gate's load a red test that
// proved nothing ("ALREADY RED unmutated").
export const DENO_DIR: string = Deno.env.get("DENO_DIR") ??
  JSON.parse(
    new TextDecoder().decode(
      (await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json"],
        stdout: "piped",
      }).output()).stdout,
    ),
  ).denoDir;

/** The HOME a test gives `run.sh` / `install.sh` — a throwaway one under
 *  `root`, which the test removes when it ends.
 *
 *  Those scripts write where a person's shell and desktop look, and none of it
 *  follows `AIO_APPS_DIR` (which is the app's DATA): run.sh puts the program in
 *  `installRoot()` — `AIO_INSTALL_ROOT`, else `~/app/<name>/` — its PATH link
 *  in `~/.local/bin/`, a GUI target's menu entry in
 *  `~/.local/share/applications/`; install.sh appends a PATH line to
 *  `~/.profile` and every rc file that exists. MEASURED 2026-10-07:
 *  tests/run-sh-e2e.test.ts spread the developer's own env and pinned none of
 *  it — four ~110 MB programs in the REAL `~/app` per `test:onboard`, 794 of
 *  them, ~140 GB, a full home disk.
 *
 *  `DENO_DIR` stays the real module cache (above). Spread it AFTER the
 *  inherited env. `tests/script-spawns-own-their-home.test.ts` requires it of
 *  every test file that runs one of those scripts. */
export async function ownHome(root: string): Promise<Record<string, string>> {
  const home = join(root, "home");
  await Deno.mkdir(home, { recursive: true });
  return { HOME: home, AIO_INSTALL_ROOT: join(home, "app"), DENO_DIR };
}

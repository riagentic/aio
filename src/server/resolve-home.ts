// resolve-home.ts — the app's data home, asked BEFORE `aio.run()`.
//
// An app that opens its own files first (a vault, a migration, a health check)
// used to compute `~/.<appId>` by hand — and under `--profile=tasks` aio moved
// its lock, logs and meta.json to `~/.<appId>-tasks` while the app kept
// opening the everyday folder (a wallet app's field report, 1.0.11). This asks
// the SAME decider `aio.run()` records (`planAppDirs`, with the same request
// and appId), without recording anything.

import { declareAppFlags, homeRequest } from "./aio-cli.ts";
import { planAppDirs } from "./app-dirs.ts";
import { resolveAppId } from "./single-instance-lock.ts";

/** Where `aio.run()` with the same `appId`/`appDir`/`profiles`/`appFlags`
 *  will keep this app's files — `--profile`/`AIO_PROFILE`/`--home` applied,
 *  refused exactly as `aio.run()` refuses (same Error text). Pure with respect
 *  to aio's registry: asking changes nothing `aio.run()` then decides. Gives
 *  the same answer inside a `worker: true` cell's thread. Not for
 *  `libraryMode` (a test harness's home comes from its `baseDir`).
 *
 *  ```ts
 *  import { resolveHome } from "aio/server";
 *  const { home } = resolveHome({ appId: "wallet" });
 *  await openVault(join(home, "data", "vault"));
 *  await aio.run({ appId: "wallet", cells, dbPath: join(home, "data", "state.db") });
 *  ```
 *
 *  `appFlags`: pass the app's own `aio.run({ appFlags })` — an app that claims
 *  `--profile` itself is not asking aio for a profile. */
export function resolveHome(opts: {
  appId?: string;
  appDir?: string;
  profiles?: boolean;
  appFlags?: readonly string[];
} = {}): { home: string; profile?: string } {
  if (opts.appFlags !== undefined) declareAppFlags(opts.appFlags);
  const { dirs, profile } = planAppDirs({
    appId: resolveAppId(opts.appId),
    appDir: opts.appDir,
    request: homeRequest(),
    profiles: opts.profiles,
  });
  return profile ? { home: dirs.home, profile } : { home: dirs.home };
}

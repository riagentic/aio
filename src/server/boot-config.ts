// Phase 1 — CLI, env, config checks: the bodies `_runPhases` (aio.ts) calls through its stubs.
// Moved out of that one function as they were; every local of the boot they
// use is read and written through `ctx` (boot-ctx.ts), live.
import { log } from "../diagnostics/logger-api.ts";
import { isFrameworkCell } from "../state/framework-cells.ts";
import { VERSION } from "./aio-cli.ts";
import { _appVersion } from "./aio-run-config.ts";
import { appDenoJson } from "./aio-run-helpers.ts";
import { describeMigration, migrateLegacyLayout } from "./app-dirs-migrate.ts";
import {
  checkUnpackLocation,
  externalDbPath,
  registeredProfile,
  sweepAppPayloadDir,
  writeAppMeta,
} from "./app-dirs.ts";
import { BUNDLE_JS } from "./app-files.ts";
import { dbPathOf } from "./config-sources.ts";
import {
  currentHeapLimitBytes,
  declaredMaxHeapOf,
  describeHeapPolicy,
  envHeapCapMB,
  physicalMemoryBytes,
  reportHeapCeiling,
} from "./heap-policy.ts";
import { distCandidates, isCompiled, resolveDataDirLegacy } from "./paths.ts";
import { PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import {
  deriveDataContract,
  PROBE_NONCE_ENV,
  probeLine,
  probeNonce,
  resolveKeepOld,
} from "./updates-core.ts";
import { dirname, join } from "@std/path";
import type { BootCtx } from "./boot-ctx.ts";

export function _printDataContract<S, A, E>(ctx: BootCtx<S, A, E>): void {
  // `aio ship` asks this before publishing: a build whose `updates.keepOld`
  // its boot would refuse is refused HERE (throws, non-zero) — the boot's
  // own refusal comes only after its judge has counted the attempt.
  resolveKeepOld(ctx.config.updates);
  // What this build promises about data already on disk. Derived from the
  // very same cell versions and onMigrate hooks the boot path uses, so a
  // published contract cannot drift from what the binary actually does.
  const contract = deriveDataContract(
    ctx.config._cellMigrations ?? new Map(),
    PERSIST_SCHEMA_VERSION,
  );
  // `console.log`, NOT `log.info`: this stdout is parsed (`aio ship`,
  // `updates-rebuild`). The logger stamps every line with a timestamp and a
  // category, which prefixed the JSON's first line and made every published
  // manifest data-less. run() has already routed the framework's own lines
  // to stderr for this mode, so this is the only thing on stdout.
  // aio-ok: the machine-readable answer itself. `log.info` would prefix it
  // with a timestamp and a category and make it unparseable — which is the
  // exact defect this mode was fixed for.
  console.log(JSON.stringify(contract, null, 2));
  // …and once more on a line of its own: the app's modules may have printed
  // to stdout before this ran, and a reader finds this line regardless —
  // by the value it handed over, when it handed one.
  const nonce = probeNonce(Deno.env.get(PROBE_NONCE_ENV));
  // aio-ok: a marker `aio ship` parses off stderr, beside the JSON on stdout.
  console.error(probeLine("data-contract", JSON.stringify(contract), nonce));
  // …and ONE fact about what the contract could not say, on stderr, where
  // this mode already routes every framework line.
  //
  // A contract with no cells has two opposite meanings — "this app persists
  // nothing" and "this app persists and promised nothing about it" — and on
  // the wire they are the same `cells: {}`. The second is the dangerous one:
  // the data gate the updater leads with has nothing to weigh, so a release
  // that cannot read a user's existing store installs without a word. A
  // field report published every one of its releases that way.
  //
  // Deliberately NOT in the contract: the contract is inside the signature,
  // and this is a build-time diagnostic, not a promise to a client. `ship`
  // runs this binary already, so the two numbers meet where the decision is.
  // aio-ok: a marker `aio ship` parses off stderr, beside the JSON on stdout.
  console.error(
    probeLine(
      "persisting-cells",
      // The app's own: aio's `updates`/`feedback` persist too, and a
      // count with them asked the author to version a cell they do not own
      // ("declares 0 cells, but this build persists 2" for a one-cell app).
      String(
        (ctx.config._persistingCellIds ?? []).filter((id) =>
          !isFrameworkCell(id)
        )
          .length,
      ),
      nonce,
    ),
  );
  // …and the identity this build RUNS as — the name every install compares a
  // manifest's signed `name` against. `ship` names a release from deno.json;
  // an `aio.run({ appId })` in code that disagrees made every release
  // refused by every install, with nothing said at publish time. Unresolvable
  // (no id anywhere) → no marker: that app cannot boot, and says so there.
  let runsAs: string | undefined;
  try {
    runsAs = resolveAppId(ctx.config.appId);
  } catch {
    // aio-ok: no id to report; the boot path throws the teaching error.
  }
  // aio-ok: a marker `aio ship` parses off stderr, beside the JSON on stdout.
  if (runsAs) console.error(probeLine("app-id", runsAs, nonce));
  Deno.exit(0);
}

export async function _checkUnpackPlace<S, A, E>(
  ctx: BootCtx<S, A, E>,
): Promise<void> {
  // A packaged app unpacks itself BEFORE any of our code runs, so this can
  // only observe where that happened — and say so when it happened somewhere
  // other users on the host can reach. Never fatal (the app works either
  // way), never silent (running world-readable is not a detail), identical in
  // dev and prod. The sweep clears the empty mount stubs a crash leaves in
  // our own payload dir — the one upkeep `/tmp` used to do for us.
  // The heap ceiling this process actually got, against the policy. V8 fixed
  // it at isolate creation, so this can only REPORT — but running on the
  // ~4 GB default when the machine allows 47 GB is exactly the setup that
  // ends in "out of memory" with most of the machine free, and it must not be
  // discovered then. `am start`, run.sh and the build all size it correctly;
  // a bare `deno run src/app.ts` is the case that lands here.
  // The same numbers the warning uses, stated unconditionally: an app that
  // died of "out of memory" with the machine half empty is a support thread
  // that starts with "what was the ceiling?".
  // A compiled binary's ceiling was decided by whoever ran the build, not by
  // this machine — the line says which, so a number the reader cannot change
  // from here is never presented as this machine's allowance.
  ctx._heapLine = describeHeapPolicy(
    Math.floor(((await currentHeapLimitBytes()) ?? 0) / (1024 * 1024)) ||
      null,
    physicalMemoryBytes(),
    isCompiled(),
  );
  sweepAppPayloadDir(ctx._dirs);
  const unsafeUnpack = checkUnpackLocation(ctx._dirs);
  if (unsafeUnpack) log.warn("security", unsafeUnpack);
  // Everything this boot WRITES into `<data>/` — the heap-notice stamp, the
  // legacy-layout migration, meta.json — runs only once the singleton lock
  // is ours (`_stampDataDir()` below). A boot the lock REFUSES — another
  // instance, or `am backup`/`am restore` holding it — must leave data/
  // byte-identical: it used to rewrite meta.json (a torn copy in a backup)
  // and could refill a data/ a restore had just moved aside.
  ctx._stampDataDir = async () => {
    await reportHeapCeiling(log, {
      // Once per machine, keyed on the numbers — see reportHeapCeiling. The
      // stamp lives beside the app's other disposables, so wiping the data dir
      // legitimately makes it say the thing again.
      // `<data>/` not `<data>/files/`: `files` is the APP's upload space
      // (created lazily, and not ours), and a write that quietly fails puts
      // the warning back on every boot.
      stampPath: join(ctx._dirs.data, ".heap-notice"),
      always: ctx.cli.verbose,
      // `memory.maxHeap` from the app's OWN deno.json — the same place
      // `build-compile.ts` reads it, entry-relative like `version` and
      // `title`. It reaches V8 only through the launch, so a bare `deno run`
      // is capped at the automatic share while the config file says 12 GB;
      // this is the surface that tells the author so (see reportHeapCeiling).
      declaredMaxHeap: declaredMaxHeapOf(appDenoJson()),
      // The launcher may have clamped the ceiling for a controlled
      // environment (see envHeapCapMB); the report must use the same cap or
      // every app the release suite spawns warns "under policy" at boot.
      capMB: envHeapCapMB(),
    });
    if (!ctx.cli.noDataMigrate) {
      const _m = migrateLegacyLayout({
        appId: ctx.appId,
        dirs: ctx._dirs,
        cwd: Deno.cwd(),
        legacyXdgDir: resolveDataDirLegacy(ctx.appId),
      });
      for (const line of describeMigration(_m, ctx._dirs)) {
        if (line.includes("FAILED") || _m.refused) log.warn("data", line);
        else log.info("data", line);
      }
    }
    writeAppMeta(ctx._dirs, {
      appId: ctx.appId,
      aio: VERSION,
      app: await _appVersion(),
      profile: registeredProfile(ctx.appId),
      // Where the database lives when `dbPath` moved it out of data/ —
      // the only record `am backup` / `am restore` have of it.
      dbPath: externalDbPath(ctx._dirs, dbPathOf(ctx.cli, ctx.config)?.value),
    });
  };
}

export async function _detectCompiledProd<S, A, E>(
  ctx: BootCtx<S, A, E>,
): Promise<void> {
  // Entry-relative (the binary's EMBEDDED dist/) first, real filesystem after
  // — so a compiled binary detects prod from ANY cwd. See distCandidates.
  const candidates = distCandidates({
    mainModule: Deno.mainModule,
    cwd: Deno.cwd(),
    execDir: dirname(Deno.execPath()),
    moduleDir: import.meta.dirname ?? null,
  });
  let sawDistDir: string | undefined;
  for (const dir of candidates) {
    try {
      await Deno.stat(join(dir, BUNDLE_JS));
      ctx.distDir = dir;
      ctx.prod = true;
      log.info("auto-detected dist/app.js → prod mode");
      break;
    } catch {
      // A dist/ that EXISTS but holds no app.js means this binary embedded a
      // bundle directory and still has nothing to serve — never a headless
      // build, always a packaging bug. Remember it so the fallback below can
      // say so instead of quietly serving the "no browser UI" page
      // (R-5).
      if (sawDistDir === undefined) {
        try {
          if ((await Deno.stat(dir)).isDirectory) sawDistDir = dir;
        } catch { /* no such dir either */ }
      }
    }
  }
  // A HEADLESS build (`--service`/`--cli`) never bundles, so there is no
  // dist/app.js to find — but a compiled binary is prod by definition (dev
  // mode means running from source). Without this the service binary fell
  // through to dev: it emitted the "esbuild not installed" warning and ran
  // the dev lint, which demands src/App.tsx at cwd → crash on any real
  // server. `deno task compile:service` shipped exactly that.
  if (!ctx.prod) {
    ctx.prod = true;
    if (sawDistDir) {
      log.warn(
        `compiled binary embeds ${sawDistDir} but it holds no app.js — ` +
          `this build packaged a bundle directory with nothing to serve, so ` +
          `the app will answer with the "no browser UI" page. Rebuild the ` +
          `browser bundle before compiling (deno task build), or build a ` +
          `headless target on purpose (--headless/--cli).`,
      );
    }
    log.info("compiled binary without a bundle → prod mode (headless)");
  }
}

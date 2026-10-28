// Phase 4 — transport and lifecycle: the bodies `_runPhases` (aio.ts) calls through its stubs.
// Moved out of that one function as they were; every local of the boot they
// use is read and written through `ctx` (boot-ctx.ts), live.
import { log } from "../diagnostics/logger-api.ts";
import { toBroadcast } from "../diagnostics/time-travel.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { startLifecycle } from "./aio-lifecycle.ts";
import { _appVersion, defaultClientFor } from "./aio-run-config.ts";
import { _appSlots } from "./aio-run-entry.ts";
import { setupTransport } from "./aio-server.ts";
import { entryPathOf } from "./boot-facts.ts";
import { tlsOf } from "./config-sources.ts";
import { checkPeerTypes } from "./peer-describe.ts";
import { ownReplayArgs } from "./updates-apply.ts";
import { updateWindow } from "./updates-boot.ts";
import { resolve } from "@std/path";
import type { BootCtx } from "./boot-ctx.ts";

export async function _setupTransport<S, A, E>(ctx: BootCtx<S, A, E>) {
  return setupTransport<S, A>({
    appId: ctx.appId,
    appVersion: await _appVersion(),
    port: ctx.port,
    portRequested: ctx._portRequested,
    prod: ctx.prod,
    distDir: ctx.distDir,
    electronDistDir: ctx.electronDistDir,
    // The shell the app runs in: the dev graph evaluation presents its UA.
    shell: defaultClientFor(ctx.config.client) === "electron"
      ? "electron"
      : "browser",
    baseDir: ctx.baseDir,
    baseDirFallbacks: ctx.baseDirFallbacks,
    expose: ctx.expose,
    token: ctx.token,
    users: ctx.users,
    resolveUser: ctx._resolveUser,
    ...(ctx.config.peerTypes !== undefined
      ? { peerTypes: checkPeerTypes(ctx.config.peerTypes) }
      : {}),
    ...(ctx.config.resolvePeer
      ? {
        resolvePeer: (p: { app: string; pid: number }) =>
          ctx.config.resolvePeer!(p, ctx.state),
      }
      : {}),
    sessionResolver: ctx.sessionResolver,
    // Every source of "this socket's user is not who it was" the boot has.
    // Built from the STORES, not from `authFlows` — `authFlows` exists only
    // under `auth: true`, which left `sessions: true` on the 5-second sweep
    // (measured: 4.8s and ten more frames of private state after a revoke).
    // A role change had no source at all; `onUserChanged` is the new one.
    onIdentityChange: (ctx.sessionStore || ctx.userStore)
      ? (fn: () => void) => {
        const offs: (() => void)[] = [];
        if (ctx.sessionStore) offs.push(ctx.sessionStore.onRevoked(fn));
        if (ctx.userStore?.onUserChanged) {
          offs.push(ctx.userStore.onUserChanged(fn));
        }
        return () => {
          for (const off of offs) off();
        };
      }
      : undefined,
    // AUTH-2/3: login-flow deps — aio-server adds the TLS-aware `secure` flag.
    authFlows: ctx.userStore && ctx.sessionStore
      ? {
        users: ctx.userStore,
        sessions: ctx.sessionStore,
        signup: ctx.authOpts.signup !== false,
        cookie: ctx.authOpts.cookie !== false,
        ttlMs: ctx.authOpts.ttlMs,
        appTitle: ctx.title,
        sendMail: ctx.authOpts.sendMail,
        requireVerified: ctx.authOpts.requireVerified,
        totp: ctx.authOpts.totp,
        oidc: ctx.authOpts.oidc,
        publicDir: ctx.authOpts.publicDir,
      }
      : undefined,
    // TLS: ONE decider for the flag/config pair. The flags are per-launch and
    // win; `tls` in config is how a compiled binary — a service unit passes no
    // shell flags — declares the same thing (R-7).
    cliCert: tlsOf(ctx.cli, ctx._tls).cert?.value,
    cliKey: tlsOf(ctx.cli, ctx._tls).key?.value,
    cliNoTls: tlsOf(ctx.cli, ctx._tls).noTls?.value,
    // Which of the two said so — the warning names what was actually written.
    noTlsSource: ctx.cli.noTls !== undefined ? "flag" : "config",
    certSource: ctx.cli.cert !== undefined || ctx.cli.key !== undefined
      ? "flag" as const
      : "config" as const,
    cliTransport: ctx.cli.transport,
    // `--no-watch` / `--watch=…` beats the config value: a flag is a decision
    // about THIS run, a config value is the app's standing preference. Merged
    // HERE because `config` below is passed whole and must stay the app's own
    // object (tests/config-bridge-hop2.test.ts).
    cliWatch: ctx.cli.watch,
    ui: ctx.ui,
    title: ctx.title,
    // HOP 2 of the config bridge — MECHANICAL, never a hand-copied literal.
    // The whole config rides across and `TransportConfig` (aio-server.ts) is
    // the single list of what may be read. The literal that used to stand here
    // silently dropped `serveDirs` (feature dead on arrival) and `_cellNames`
    // (browser drift warning unreachable), after strictOrigin/redactActions/
    // appDir/renderBudget did the same at hop 1. Gate:
    // tests/config-bridge-hop2.test.ts.
    config: ctx.config,
    getState: () => ctx.state,
    getUIState: (s, user?) => ctx.getUIState(s, user),
    // ROUTED dispatch: a network-borne action for a `worker: true` cell must
    // reach its worker, not be reduced here. The raw dispatcher would have run
    // the method on the main isolate — no isolation at all, and the worker's
    // copy of the slice would drift out of sync with ours.
    //
    // …and an action that came in through a network door has no call for an
    // author — no call's continuation made it. Known, not guessed (`_sureOf`):
    // its failed save is its own ack's, not every open call's.
    dispatch: (action) => {
      if (action !== null && typeof action === "object") {
        ctx._sureOf.add(action as object);
      }
      return ctx.appDispatch(action as A);
    },
    closing: () => ctx.dispatch.phase() !== "open",
    app: {
      snapshot: () => ctx.app.snapshot!(),
      loadSnapshot: (json, opts) => ctx.app.loadSnapshot!(json, opts),
    },
    blobs: ctx.blobStore,
    vitalsSystem: ctx.vitalsSystem,
    costMeter: ctx.costMeter,
    useElectron: ctx.useElectron,
    tt: ctx.tt
      ? {
        handleTTCommand: ctx.handleTTCommand,
        getTTBroadcast: () => toBroadcast(ctx.tt!),
      }
      : null,
    syncHandler: ctx.syncHandler ?? null,
    syncBroadcastRef: ctx.syncBroadcastRef,
    shutdown: ctx.shutdown,
    udsHandle: ctx.udsRef,
    // `am persist` / trojan `persist`: the reply is the claim "on disk", so
    // this is the flush itself, awaited, and a cycle that reported a failure
    // rejects (the manager never rejects on its own — it keeps the loop alive
    // — so the verdict is read back from `lastCycleError`). Sync cells'
    // server-origin writes debounce into their own snapshot; they ride too,
    // exactly as on a clean exit.
    flushPersist: async () => {
      await ctx.persistence.flushPersist();
      await ctx.syncHandler?.flushServerWrites();
      const failed = ctx.persistence.lastCycleError();
      if (failed) throw failed;
    },
    // The SAME value, read by `/__aio/health` — one verdict, every door.
    lastPersistError: () => ctx.persistence.lastCycleError(),
    // `am persist --drop`: an undeclared stored cell out of every future
    // write — and out of `am migrations`' drift list, which said it was
    // still stored.
    dropStoredCell: (cell: string) => {
      const r = ctx.persistence.dropOrphanCell?.(cell) ?? [];
      if (r === true && ctx.migrationSummary) {
        ctx.migrationSummary.drift = ctx.migrationSummary.drift.filter((d) =>
          !(d.cell === cell && d.issue === "unknown-cell")
        );
      }
      return r;
    },
    budgets: ctx._budgetLedger,
    shouldPersist: ctx.shouldPersist,
    scheduleManager: ctx.scheduleManager,
    // Cell id → method names — trojan `cells` route (amui run-method buttons).
    cellMethods: ctx.config._cellMethods ?? {},
    cellAsyncMethods: ctx.config._cellAsyncMethods ?? {},
    cellMethodArity: ctx.config._cellMethodArity ?? {},
    cellFields: ctx.config._cellFields ?? {},
    // The same version / converts-state facts boot replay reads, for every
    // declared cell — `am replay` applies the one stamp rule (staleStamps).
    cellVersions: Object.fromEntries(
      (ctx.config._cellNames ?? []).map((c) => [c, {
        version: ctx.config._cellVersions?.[c] ?? 0,
        migrates: !!ctx.config._cellMigrations?.get(c)?.onMigrate,
      }]),
    ),
    asyncDb: ctx.asyncDb,
    // In-memory dispatch timeline — the trojan `timeline` route.
    getTimeline: (after?: number, limit?: number) =>
      ctx.timeline.entries(after, limit),
    getTimelineRotated: () => ctx.timeline.rotated(),
    // Boot migration + shape-drift picture — trojan `migrations`.
    migrations: ctx.migrationSummary,
    appLock: ctx.appLock,
    clientCounter: ctx.clientCounter,
    log,
  });
}

export async function _startLifecycle<S, A, E>(
  ctx: BootCtx<S, A, E>,
): Promise<void> {
  return startLifecycle({
    // Boot-report auth label — "password+totp+oidc", "sessions", or fallback.
    authMode: ctx.authEnabled
      ? [
        "password",
        ctx.authOpts.totp !== false ? "totp" : "",
        ctx.authOpts.oidc ? "oidc" : "",
        ctx.authOpts.requireVerified ? "verified-email" : "",
      ].filter(Boolean).join("+")
      : ctx.sessionStore
      ? "sessions"
      : undefined,
    // Facts the report cannot read off the process: where this app keeps what
    // it owns, and what it is actually running.
    bootExtras: {
      pid: Deno.pid,
      // `--verbose`: every setting with more than one home, the value it
      // resolved to and WHO decided — from the same resolvers that decided it
      // (config-sources.ts), so the label cannot disagree with the value.
      sources: ctx.VERBOSE ? ctx._settings : undefined,
      client: { value: ctx.client, from: ctx.clientFrom },
      // An app that binds no TCP port has no port fact to report. It used to
      // print one anyway — `findFreePort()` runs before the transport is even
      // decided — so a zero-port app announced a number it never bound, and
      // anyone who tried it got a refused connection. `sourced()` drops an
      // undefined value, and the socket is named on its own line instead.
      port: { value: ctx._tcpPort as number, from: ctx.portFrom },
      entry: {
        // What is RUNNING, read from the process — not what a config said
        // should run. Those differ exactly when someone is confused.
        value: entryPathOf(Deno.mainModule),
        from: "default",
      },
      heap: ctx._heapLine,
      plugins: ctx.config._pluginNames,
      dataDir: ctx._dirs.home,
      // `--db-path` moves the state file OUT of the data dir, and a relative
      // one resolves against CWD — so the `data` line above was pointing at a
      // directory the state was not in. Resolved, because "./rel.db" is not an
      // answer to "where is it".
      dbFile: ctx.dbPath ? resolve(ctx.dbPath) : undefined,
      logs: { dir: ctx._dirs.logs, level: ctx.cli.verbose ? "debug" : "info" },
      journal: ctx.config.journal
        ? (typeof ctx.config.journal === "string"
          ? ctx.config.journal
          : ctx._dirs.journal)
        : undefined,
      cells: Object.keys(ctx.config._cellMethods ?? {}),
      // What is NOT ordinary about a cell: its own thread, or a second writer.
      // Both change how a symptom is read, and neither was visible without
      // opening the source.
      workers: [...getRegisteredCells().values()]
        .filter((c) => (c as { __aio?: { worker?: boolean } }).__aio?.worker)
        .map((c) => (c as { __aio: { id: string } }).__aio.id),
      syncCells: [...getRegisteredCells().values()]
        .filter((c) =>
          (c as { __aio?: { syncConfig?: unknown } }).__aio?.syncConfig !==
            undefined
        )
        .map((c) => (c as { __aio: { id: string } }).__aio.id),
      routes: ctx.config.routes ? Object.keys(ctx.config.routes).length : 0,
      feedback: ctx._feedback
        ? {
          auto: ctx._feedback.auto,
          keep: ctx._feedback.keep,
          destination: ctx._feedback.url ??
            (ctx._feedback.hasSink ? "custom sink" : undefined),
        }
        : undefined,
      updates: ctx._updates
        ? {
          source: ctx._updates.source,
          kind: ctx._updates.kind,
          channel: ctx._updates.channel,
          intervalMs: ctx._updates.intervalMs,
          auto: ctx._updates.auto,
        }
        : undefined,
    },
    appId: ctx.appId,
    appVersion: await _appVersion(),
    title: ctx.title,
    prod: ctx.prod,
    electronDistDir: ctx.electronDistDir,
    distDir: ctx.distDir,
    baseDir: ctx.baseDir,
    expose: ctx.expose,
    singletonMode: ctx.singletonMode,
    childWindows: !!ctx.config.childWindows,
    electron: ctx.config.electron,
    splash: ctx.config.splash,
    client: ctx.client,
    useElectron: ctx.useElectron,
    isHeadless: ctx.isHeadless,
    libraryMode: ctx.config.libraryMode,
    transport: ctx.transport.transport,
    skipHttp: ctx.transport.skipHttp,
    httpSocketPath: ctx.transport.httpSocketPath,
    port: ctx.livePort,
    token: ctx.token,
    pairingPake: ctx.config.pairing?.pake === true,
    users: ctx.users,
    perUserAuth: ctx._perUserAuth,
    tlsCert: ctx.transport.tlsCert,
    shareUrl: ctx.transport.shareUrl,
    localUrl: ctx.transport.localUrl,
    advertiseHost: ctx.transport.advertiseHost,
    bindHost: ctx.transport.bindHost,
    server: ctx.server,
    udsHandle: ctx.udsHandle,
    app: ctx.app,
    // `onStart` here is the cells bridge's: it runs every cell's `onInit`
    // (the app's own `onStart` fires later, from `aio.run`). Boot re-creates
    // what `onInit` dispatches — every harness runs it too — so it is caused,
    // like a timer a method arms. Recorded as an input, `am record` emitted
    // the call AND `bootCells` ran `onInit`: applied twice.
    //
    // Worker cells' `onInit` runs in THEIR isolate, started here — beside the
    // main cells' and no earlier: a patch it dispatches is applied through
    // this isolate's dispatch, whose broadcast is wired only now. Posted
    // BEFORE the main `onInit`s, so a main cell calling a worker cell from its
    // own `onInit` reaches one that has already initialised (per-worker FIFO).
    onStart: ctx.onStart || ctx.workerPool.size > 0
      ? ((a: Parameters<NonNullable<typeof ctx.onStart>>[0]) => {
        ctx.workerPool.start();
        if (ctx.onStart) {
          return ctx._effectScope.run(true, () => ctx.onStart!(a));
        }
      })
      : undefined,
    fatalOnStart: ctx.config.fatalOnStart,
    scheduleManager: ctx.scheduleManager,
    schedules: ctx.config.schedules,
    shouldPersist: ctx.shouldPersist,
    persistMode: ctx.persistMode,
    asyncDb: ctx.asyncDb,
    db: ctx.config.db,
    maxConnections: ctx.config.maxConnections,
    cli: {
      width: ctx.cli.width,
      height: ctx.cli.height,
      keepServer: ctx.cli.keepServer,
      open: ctx.cli.open,
      // Read by the report only, to say when `--channel` can do nothing.
      channel: ctx.cli.channel,
    },
    // The FULL head-shaped config, not just the window box: the dev Electron
    // aio:// shell is templated at launch and has no other way to learn
    // ui.head/ui.viewport/ui.showStatus. Dropping them here made an app that
    // respected ui.head under `deno task dev` (HTTP) ship it in the packaged
    // window but NOT in the dev Electron window — two dev surfaces, two heads
    // (WYSIDIWYSIP).
    // EVERY key the lifecycle's `ui` type names — not a hand-picked five.
    // The list here silently lost chrome, theme, layout and lang (and then
    // tray) on the way to the dev Electron launch: the lifecycle read
    // `ui.chrome` from an object that never had it, so the templated shell
    // drew the OS frame whatever the app asked for. Measured: `const TRAY =
    // null` in the generated main of an app that configured a tray.
    ui: {
      width: ctx.ui.width,
      height: ctx.ui.height,
      showStatus: ctx.ui.showStatus,
      viewport: ctx.ui.viewport,
      head: ctx.ui.head,
      chrome: ctx.ui.chrome,
      theme: ctx.ui.theme,
      layout: ctx.ui.layout,
      // …and `dir` is the key it lost NEXT, after the five the comment above
      // was written about. The lifecycle's `ui` shape is a `Pick<UiConfig>`
      // now, so a key it names and this object omits is a compile error
      // rather than a config that reaches no target.
      dir: ctx.ui.dir,
      lang: ctx.ui.lang,
      tray: ctx.ui.tray,
    },
    security: ctx.config.security,
    wire: ctx.config.wire,
    keepServer: ctx.config.keepServer,
    setElectronProc: (proc) => {
      ctx._electronProc = proc;
    },
    stopSignal: ctx._stopCtl.signal,
    // The update this boot judged, told what the window's start did.
    window: !ctx.config.libraryMode && _appSlots.get(ctx.config)
      ? updateWindow(
        ctx._dirs.data,
        log,
        _appSlots.get(ctx.config)!.window,
        ownReplayArgs(),
      )
      : undefined,
    setDiscoveryStop: (stop) => {
      ctx.discoveryRef.stop = stop;
    },
    appLock: ctx.appLock,
    log,
  });
}

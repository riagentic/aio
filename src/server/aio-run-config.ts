// Run config deciders — the module-level answers `aio.run` asks before and
// during a boot: exposure, TLS, the pin-drift and misplaced-deno.json hints,
// the theme note, the app version, the client, the help facts, the base dirs
// and the stderr-only log sink. Split out of aio.ts, which re-exports every
// name here, so no importer changes.

import { refuseRetired } from "../state/removals.ts";
import { APP_STYLE } from "./app-files.ts";
import { readLocalPinSync } from "./deno-json.ts";
import { log } from "../diagnostics/logger-api.ts";
import type { LogSink } from "../diagnostics/logger-types.ts";
import type { Sourced } from "./boot-facts.ts";
import { exposeFlagOf, hostOf, pickOr } from "./config-sources.ts";
import { appDenoJson } from "./aio-run-helpers.ts";
import { appDenoJsonLocated } from "./aio-run-helpers.ts";
import {
  readBuildStamp,
  resolveRuntimeVersion,
  runtimeTreeFacts,
  unresolvedTreeVersion,
} from "./app-version.ts";
import { VERSION } from "./aio-cli.ts";
import { baseDirCandidates, isCompiled } from "./paths.ts";
import { basename, fromFileUrl } from "@std/path";
import type { UiConfig } from "./aio-types.ts";
import { misplacedDenoJsonKeys, retiredDenoJsonKeys } from "./config.ts";

/** THE decider for "is this app reachable off loopback?" — nothing else in the
 *  framework may answer that question its own way.
 *
 *  It used to be answered twice: `parseCli().expose` for the `ui:"all"` privacy
 *  warning, and `cli.expose ?? false` for the transport. That was survivable
 *  only while `--expose` was the sole source; the moment `expose` became a
 *  config key (a compiled binary in a service unit has no shell flags), a
 *  config-exposed app would have bound 0.0.0.0 with the privacy warning
 *  silently switched off — a quiet failure exactly where it costs most.
 *
 *  CLI wins over config: the operator running the binary overrides the author.
 *  Structural param so it works for both CellsConfig (outer `run`) and
 *  AioConfig (inner `_run`) without importing either.
 *
 *  `host` IS an exposure decision, and it was a SECOND, unguarded one.
 *  `host: "0.0.0.0"` (or a LAN address, or `--host=…`) binds every interface
 *  while `expose` stayed false — so no shared key was generated, no auto-TLS
 *  ran, `strictOrigin` was ignored and not one of the "this app is OPEN"
 *  warnings fired. The app was reachable from the network with no credential
 *  at all, which is precisely the state `--expose` exists to make loud. This
 *  function's whole reason to exist is that exposure has ONE decider, so it
 *  reads both keys. A loopback `host` (the default, or an explicit
 *  `--host=127.0.0.1`) is not exposure and changes nothing.
 *
 *  @decider */
export function _exposeOf(
  cli: { expose?: boolean; host?: string },
  config: { expose?: boolean; host?: string },
): boolean {
  if (exposeFlagOf(cli, config).value) return true;
  return _hostIsExposed(hostOf(cli, config)?.value);
}

/** WHY this app counts as exposed, spelled the way its author wrote it.
 *
 *  Mirrors {@link _exposeOf} branch for branch, because a warning that names
 *  the wrong cause costs more time than no warning at all: once a non-loopback
 *  `host` became a second source of exposure, every "--expose with …" line was
 *  telling an author about a flag they had never typed. Three call sites spelled
 *  this fact for themselves and two of them were wrong the moment that landed —
 *  so it is decided here, once. */
export function exposeReason(
  cli: { expose?: boolean; host?: string },
  config: { expose?: boolean; host?: string },
): string {
  if (cli.expose) return "--expose";
  if (config.expose) return "expose: true";
  if (cli.host && _hostIsExposed(cli.host)) return `--host=${cli.host}`;
  const h = config.host;
  if (h && _hostIsExposed(h)) return `host: ${JSON.stringify(h)}`;
  return "--expose";
}

/** True when binding this host reaches something other than loopback.
 *  Unknown/unparsable names fail CLOSED (treated as exposed): an app bound to
 *  a name we cannot classify must get the loud treatment, not the quiet one. */
export function _hostIsExposed(host: string | undefined): boolean {
  if (host === undefined) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "") return false;
  return !(h === "127.0.0.1" || h === "::1" || h === "localhost" ||
    h.startsWith("127."));
}

/** Resolve `config.tls` into the three transport knobs the server reads.
 *  THE tls decider — the CLI flags override its result in ONE place (the
 *  aio-server call site), and an unusable shape is refused here, at boot,
 *  instead of surfacing as a handshake failure later.
 *
 *  Config exists for the same reason `expose` does: a compiled binary started
 *  by a service unit has no shell flags, so "how this app serves" has to be
 *  expressible in code (R-7). */
/** Warn when the aio actually running is not the aio the app pinned.
 *
 *  `dep/aio` is often a SYMLINK to a live checkout, so "the installed version"
 *  is whatever that tree is this minute. An app declared alpha55 and was
 *  running alpha61 plus uncommitted work — six releases of drift, discovered
 *  by a semantics change nobody could explain. The framework knows both
 *  numbers; the app should not have to run a linter to learn they differ.
 *
 *  A WARNING, not a refusal: developing against a moving checkout is a
 *  legitimate workflow (it is how aio itself is developed). What is not
 *  legitimate is doing it silently. Once per process. */
let _pinWarned = false;
export function _warnPinDrift(): void {
  if (_pinWarned) return;
  _pinWarned = true;
  // A local path override (`.aio/pin.local`) IS the pin on this machine; the
  // committed `aioVersion` is what other clones get. Nothing to compare here.
  if (readLocalPinSync(Deno.cwd())) return;
  const declared = appDenoJson()?.aioVersion;
  if (typeof declared !== "string" || declared === "") return;
  // A path pin (`path:/abs/checkout`) IS "whatever that tree is" by
  // construction — the developer said so. Nothing to compare.
  if (declared.startsWith("path:")) return;
  const want = declared.replace(/^v/, "");
  if (want === VERSION) return;
  log.warn(
    `version: this app pins aio ${declared} (deno.json aioVersion) but is ` +
      `RUNNING ${VERSION}. Everything below — defaults, semantics, the wire ` +
      `protocol — is ${VERSION}'s. Run \`am pin ${declared}\` to get what the ` +
      `app declares, or \`am pin latest\` to record what it is running.`,
  );
}

/** What boot says about `ui.theme`, or null when there is nothing to say.
 *
 *  Pure so it can be tested: both lines are documented behaviour in shipped
 *  upgrade guides ("Boot says so, once"), and the `"full"` one was silently
 *  wrong in every compiled binary for two releases because the stylesheet
 *  probe behind it looked in one directory. A line the framework promises is a
 *  line a test owes. */

export function _themeBootNote(
  theme: UiConfig["theme"],
  styled: boolean,
  layout?: boolean,
): { level: "info" | "warn"; message: string } | null {
  if (theme !== "full" && theme !== "auto") {
    // `ui.layout: false` on a theme that paints nothing is a setting with no
    // effect — and a setting with no effect is worse than a missing one,
    // because the author believes it is doing something.
    if (layout === false) {
      return {
        level: "warn",
        message:
          `ui.layout: false has no effect with ui.theme "${
            theme ?? "tokens"
          }" — ` +
          `that theme emits no visual rules, so there is no layout to drop. ` +
          `Set ui.theme "full" (or "auto") to get the ELEMENT defaults ` +
          `— canvas, type, forms, tables, focus rings — without the page ` +
          `container or the six layout classes.`,
      };
    }
    return null;
  }
  if (layout === false) {
    return {
      level: "info",
      message:
        `theme: ui.theme "${theme}" with ui.layout false — aio styles ELEMENTS ` +
        `(canvas, type, forms, tables, code, focus rings) and emits NO layout: ` +
        `no \`<main>\` page container and none of .card/.row/.stack/.grid/` +
        `.muted/.badge. Your CSS owns where things go.`,
    };
  }
  if (theme === "full" && styled) {
    return {
      level: "warn",
      message:
        `theme: ui.theme "full" — aio's complete stylesheet is emitted ALONGSIDE ` +
        `your ${APP_STYLE}, so its rules apply wherever your CSS is silent ` +
        `(a cascade layer settles conflicts, not silence). That is what this ` +
        `setting is for; "auto" steps aside instead, and ` +
        `\`am theme adopt\` hands you the CSS to own.`,
    };
  }
  if (styled) return null; // "auto" + a stylesheet: the app owns the stage
  return {
    level: "info",
    message:
      `theme: aio's default look is in effect (ui.theme "${theme}", no ` +
      `${APP_STYLE}) — it styles semantic HTML plus .card/.row/.stack/` +
      `.grid/.badge, and \`<main>\` becomes a centred page container. ` +
      `Write ${APP_STYLE} and every visual default steps aside.`,
  };
}

export function _tlsOf(
  config: { tls?: "auto" | false | { cert: string; key: string } },
): { cert?: string; key?: string; noTls: boolean } {
  const t = config.tls;
  if (t === undefined || t === "auto") return { noTls: false };
  if (t === false) return { noTls: true };
  if (
    typeof t === "object" && t !== null &&
    typeof (t as { cert?: unknown }).cert === "string" &&
    typeof (t as { key?: unknown }).key === "string" &&
    (t as { cert: string }).cert !== "" && (t as { key: string }).key !== ""
  ) {
    return { cert: t.cert, key: t.key, noTls: false };
  }
  throw new Error(
    `[aio] invalid \`tls\` config: ${JSON.stringify(t)} — use "auto" ` +
      `(self-signed, the default), false (plain HTTP; sound only behind a ` +
      `TLS-terminating proxy or with an already-encrypted payload), or ` +
      `{ cert: "./cert.pem", key: "./key.pem" }.`,
  );
}

/** The app's own `version` — from THE app-deno.json decider
 *  ({@link appDenoJson}), entry-relative and never the launch cwd. A compiled
 *  binary launched from an unrelated project's directory used to read THAT
 *  project's deno.json and report its version as its own: the exact
 *  identity-adoption bug `resolveAppId` guards against, one field down. */
/** One-time boot warning for aio-shaped keys at the top level of deno.json.
 *
 *  Once per process, like every other boot hint here: `parseCli`-adjacent code
 *  runs several times in one boot and a repeated diagnostic reads as a loop. */
let _hintedMisplacedDenoJson = false;
/** How a config refusal ends the boot. `libraryMode` promises "no
 *  `Deno.exit`" — a test runner or an embedding host must survive its own
 *  typo — so there the refusal (already logged, with the valid keys) THROWS
 *  out of `aio.run()` instead of exiting the process. Otherwise `undefined`:
 *  `validateConfig`'s own default, `Deno.exit`. */
export function _configExit(
  libraryMode: boolean | undefined,
): ((code: number) => never) | undefined {
  if (!libraryMode) return undefined;
  return (code: number): never => {
    throw new Error(
      `[aio] invalid aio.run() configuration — refused (see the error ` +
        `logged above for the key and the valid ones). libraryMode throws ` +
        `here instead of Deno.exit(${code}).`,
    );
  };
}

export function _warnMisplacedDenoJson(): void {
  if (_hintedMisplacedDenoJson) return;
  const stray = misplacedDenoJsonKeys(appDenoJson());
  if (stray.length === 0) return;
  _hintedMisplacedDenoJson = true;
  log.warn(
    `deno.json has aio config at the TOP LEVEL — aio never reads it there, ` +
      `so ${stray.map((k) => `"${k}"`).join(", ")} ${
        stray.length === 1 ? "is" : "are"
      } silently doing nothing. Move ${
        stray.length === 1 ? "it" : "them"
      } into aio.run({ ${stray.join(", ")} }) in your app entry. ` +
      `(deno.json carries only identity and build: appId, title, hue, client, ` +
      `entry, build, version.)`,
  );
}

let _appVersionCache: Promise<string> | undefined;
/** THE version this process reports — `major.minor.<commit count>`, the same
 *  string the build stamps into an artifact. Resolved ONCE per process
 *  (`resolveRuntimeVersion` is the pure rule; see app-version.ts): a compiled
 *  binary reads the stamp the build embedded, a source run derives it from
 *  the app's own repository — with
 *  `-dirty.<hash8>` when the tree is dirty, exactly as a build would name it.
 *
 *  It used to fall back to `"0.0.0"` — a CONFIDENT WRONG NUMBER, printed
 *  exactly when "which build is this?" matters most. An unknown version now
 *  SAYS unknown, and the update check refuses the string by name. */
export function _appVersion(): Promise<string> {
  _appVersionCache ??= (async () => {
    const located = appDenoJsonLocated();
    const compiled = isCompiled();
    const stamp = located ? readBuildStamp(located.dir) : null;
    let tree = null;
    if (!compiled && located && located.dir.protocol === "file:") {
      const root = fromFileUrl(located.dir);
      try {
        tree = await runtimeTreeFacts(root, located.config);
      } catch (e) {
        // The tree read REFUSES a tree past its caps (a stray deno.json made
        // an ancestor — `$HOME`, in one measured case — look like the project,
        // and hashing it was an unbounded read). The version is then UNKNOWN,
        // never a wrong hash: one short line in the string every surface
        // prints, and the full teachable text — which names the root — here,
        // once (this resolves once per process).
        log.warn(e instanceof Error ? e.message : String(e));
        return unresolvedTreeVersion(e);
      }
    }
    return resolveRuntimeVersion({
      declared: located?.config.version,
      compiled,
      stamp,
      tree,
    });
  })();
  return _appVersionCache;
}

/** THE default client when no `--client` flag is given: the app's config,
 *  else deno.json's build target, else electron. Boot and `--help` both read
 *  this one function, so what help prints is what boot does. */
export function defaultClientFor(configClient?: string): string {
  return clientOf({}, { client: configClient }).value;
}

/** THE client decider: `--client` > `aio.run({ client })` > the app's
 *  deno.json `client` > electron — value and source from one list. It was
 *  spelled out at three sites, with its source re-derived at a fourth. */
export function clientOf(
  cli: { client?: string },
  config: { client?: string },
): Sourced<string> {
  return pickOr<string>(
    "electron",
    ["flag", cli.client],
    ["config", config.client],
    ["deno.json", _denoJsonTargetClient()],
  );
}

/** What `--help` says about THIS invocation: a compiled binary is run by its
 *  own name, a source app by `deno run`. */
export function _helpFacts(
  configClient?: string,
): { usage: string; defaultClient: string } {
  return {
    usage: isCompiled()
      ? `${basename(Deno.execPath())} [flags]`
      : "deno run -A src/app.ts [flags]",
    defaultClient: defaultClientFor(configClient),
  };
}

/** The app's `client` from ITS OWN deno.json (written by `am create
 *  --target=…`) as a client-mode default. Makes the scaffolded `deno task dev`
 *  (no --client flag) run the CHOSEN target instead of the framework's electron
 *  fallback. `server` → `server-only` (aio's name for "no client UI");
 *  `android` → the browser client (the android dev flow's emulator connects to
 *  the same dev server).
 *
 *  The key was called `target` before alpha52 (renamed: deno.json also carries
 *  `build.targets`, a DIFFERENT axis — two meanings of "target" in one file).
 *  The old spelling was retired in alpha70 (src/state/removals.ts): dev
 *  refuses by name, prod logs — `am fix` renames it.
 *
 *  Entry-relative via {@link appDenoJson}, like `version` and `title`: read
 *  from the launch cwd, a compiled `"client": "browser"` app started anywhere
 *  else fell back to ELECTRON and began downloading a ~100MB runtime on a
 *  headless server — or picked up an unrelated project's target. */
export function _denoJsonTargetClient():
  | "browser"
  | "electron"
  | "cli"
  | "server-only"
  | undefined {
  const dj = appDenoJson();
  // Retired keys (`target`, …) are refused in dev and logged in prod by ONE
  // decider — never silently read as the new spelling.
  if (dj) {
    for (const r of retiredDenoJsonKeys(dj)) refuseRetired(r, "deno.json");
  }
  // In prod the retired key was logged above and is still HONOURED — an app
  // that only ever said `target` must not silently boot as another shell.
  const raw = dj?.client ?? (dj as { target?: unknown } | undefined)?.target;
  switch (raw) {
    case "browser":
    case "android":
      return "browser";
    case "electron":
      return "electron";
    case "cli":
      return "cli";
    case "server":
    case "server-only": // the --client= flag's spelling, written here too
      return "server-only";
    case undefined:
      return undefined;
    default:
      // Never silent: an unknown value fell through to the electron default
      // and the boot then blamed a missing App.tsx, never the typo.
      if (!_warnedClient) {
        _warnedClient = true;
        log.warn(
          "aio",
          `deno.json "client": ${JSON.stringify(raw)} is not a client — ` +
            `ignored, so the default client runs. Use one of: "browser", ` +
            `"electron", "cli", "server" (no UI), "android".`,
        );
      }
      return undefined;
  }
}

/** The unknown deno.json `client` was said (once per process). */
let _warnedClient = false;

/** THE app-dir ladder for this process, most authoritative first — see
 *  `baseDirCandidates`, which owns the rule. Every input is read here and
 *  nowhere downstream, so one process has one answer. */
export function _inferBaseDirs(): [string, ...string[]] {
  return baseDirCandidates({
    mainModule: Deno.mainModule,
    cwd: Deno.cwd(),
    compiled: isCompiled(),
  });
}

/** A LogSink that writes EVERY line to stderr — installed only for
 *  `--aio-data-contract`, whose stdout is a machine-read JSON document.
 *
 *  Nothing is dropped: a boot that fails while answering the query must still
 *  say why, and `2>&1` puts it all back. Only the stream changes. */
export function stderrOnlyLogSink(): LogSink {
  return {
    logDir: "",
    pub(lvl, cat, msg, data) {
      const d = data ? "  " + JSON.stringify(data) : "";
      // aio-ok: this IS the levelled sink, redirected. `--aio-data-contract`
      // must put ONLY its JSON on stdout (aio's own `ship` parses it), so
      // every framework line is re-emitted on stderr — nothing is dropped,
      // `2>&1` restores the normal view, and the level is carried in the text.
      console.error(`${lvl.toUpperCase()}  ${cat}  ${msg}${d}`);
    },
    perf() {},
    flush() {
      return Promise.resolve();
    },
  };
}

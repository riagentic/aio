// am-help-text.ts — the words `am help` prints, and the template list they
// name. A LEAF: it imports nothing, so a gate can read it without dragging in
// the server (`am-cmd-meta.ts` imports `VERSION` from aio.ts, which pulls the
// whole runtime and its side effects into anything that wants one string).
//
// It is also where the template list finally stops being written twice.
// `am help` used to carry its own copy — `--template=counter|todo` while
// `--template=cli` worked — and the copy was held equal to the scaffolder's by
// a test that READ am-cmd-create.ts's source with a regex. One home needs no
// such test, and cannot drift.

/** THE scaffold templates: what `am create --template=` accepts, and what the
 *  help offers. `am-cmd-create.ts` re-exports this as its own. */
export const TEMPLATES = [
  "counter",
  "todo",
  "cli",
  // Two more, each encoding something documentation cannot make anyone read.
  // `canvas`: the shape that makes a WebGL/2D app testable — the decisions
  // pulled out of the imperative shell as pure functions, which is the pattern
  // a report found unaided after the whole 3D half of its app turned out to
  // have no framework test. `assets`: an `assets` mount plus a real file, so
  // the deno.json declaration and the directory exist together and the build
  // embeds them — the half people forget is the declaration.
  "canvas",
  "assets",
] as const;
export type Template = (typeof TEMPLATES)[number];

/** THE build targets: what `am create --target=` accepts, and what the help
 *  offers. `am-cmd-create.ts` re-exports this as its own — the same shape
 *  TEMPLATES uses above, and for the same reason. The help line USED to omit
 *  `--target` entirely while the usage line (printed on misuse) listed all
 *  five, so `am help create` could not answer "how do I create an electron
 *  app?" — the question that found this. One home, named in both places. */
export const TARGETS = [
  "browser",
  "electron",
  "android",
  "cli",
  "server",
] as const;
export type Target = (typeof TARGETS)[number];

/** What `am create` accepts — ONE list, read by the refusal on an unknown flag
 *  and by the help.
 *
 *  There were four surfaces and four answers: the parser took six flags, the
 *  refusal named all six, `am help create` named one, and `am-flags.ts`'s
 *  ungated-verb note advertised a `--dir` the command REFUSES by name ("there
 *  is no --dir; cd where you want it first"). For the verb people run first.
 *  Same fix as TEMPLATES and TARGETS above: one home, interpolated. */
export const CREATE_FLAGS: readonly string[] = [
  `--template=<${TEMPLATES.join("|")}>`,
  `--target=<${TARGETS.join("|")}>`,
  "--css=tailwind",
  "--aio-version=<v>",
  "--mirror[=<path>]",
  "--jsr",
  "--force",
];

export const HELP_TEXT = `If you are an AI agent, start here:
  agent                   THE BRIEF (Markdown) — how aio works, the verbs, and
                          the seven rules that protect the user (never kill
                          apps by process match, never open windows on their
                          desktop, never script around am, learn before
                          editing, check → run → test, type not interface, the
                          repair verbs). One command, no docs to open.
                          --min (small context) · default page · --max (all);
                          --task=<slug> for one section, --list for the index.

Onboard:
  create <name> [flags]   Scaffold a new aio app (runnable + buildable), in
                          ./<name> — there is no --dir, cd first. Flags:
                            ${
  CREATE_FLAGS.join("\n                            ")
}
                          --target picks what \`deno task dev\`/\`compile\`
                          produce by default: browser needs no toolchain,
                          electron auto-installs Electron, android needs the
                          Android SDK + Gradle. --aio-version pins the
                          framework (a release tag, or "main"); --mirror
                          imports from a local aio checkout; --jsr pins JSR
                          imports instead of the source default.
  upgrade [<app>|<dir>]   Update am itself to the latest release. One verb,
                          the object says which: "am upgrade <app>" upgrades
                          an installed APP; "am upgrade <checkout-dir>"
                          switches the GLOBAL am to that checkout's am (a dev
                          am on live files — your edits apply at once)
  uninstall               Remove am (your aio apps are untouched)

Build & run (each IS the app's own task — the same command line, run for you,
so \`am build\` and \`deno task build\` can never differ):
  build [target…]         = deno task build — every target in deno.json
                          build.targets → dist/ + manifest.json. Words narrow
                          it (am build server electron = --targets=…); fleet
                          flags pass through (--list --release --force
                          --platforms=… --all-platforms)
  compile [target]        = deno task compile — the DEFAULT target (deno.json
                          "client") alone; \`am compile cli\` = build --targets=cli
  dev [flags]             = deno task dev — in the FOREGROUND (your terminal,
                          your Ctrl-C); flags pass through (--client=electron
                          --expose --port=N --cdp --watch=false). \`am start\` is
                          the supervised background form: lock, health wait,
                          am stop/status — and the one an AGENT wants, because
                          a foreground app dies with the shell that launched it
  dev --cdp[=PORT]        DEVTOOLS / INSPECT / DEBUG the Electron window: opens
                          Chrome DevTools Protocol, which is what \`am shot\`
                          and \`am eval\` drive. No launcher shim needed
  dev --watch=false       NO WATCH / disable live reload for this run; narrow
                          it instead with \`watch: ["src/ui"]\` in aio.run()

Release:
  publish [--key=K]       Build, sign and lay out the channel directory an
                          update client fetches (<dir>/<channel>/<os>-<arch>.json
                          beside its artifact). --dir=DIR --channel=C --notes=…
                          --targets=… --target=<one, when two build for one
                          platform> --no-build (publish what dist/ holds)
                          --allow-dirty (publish a -dirty/-nogit build; logged)

Visual manager:
  ui                      Open amui, the visual app manager (Electron;
                          \`am ui --client=browser\` opens a browser tab instead)

Process (singleton — one instance per app identity):
  start [component]       Start the app and WAIT until it answers (--no-wait
                          returns as soon as it is spawned; --wait=N sets the
                          budget). Kills zombies, refuses if already
                          running. In a project that declares COMPONENTS —
                          several entries in one repo — plain "am start" starts
                          all of them and "am start <label>" starts one.
  stop [component]        Graceful shutdown (SIGTERM → SIGKILL). Stops the
                          whole project when it declares components.
  stop --all              Stop EVERY app of this project, declared or not —
                          scoped to instances whose cwd is under this project
                          root, so another project's app is never touched
                          (am instances is machine-wide, this is not).
  start --display=<what>  WHERE THE WINDOW GOES. Default \`auto\`: a launch with
                          no human on the terminal (an agent, a script) opens
                          its window on a nested X display instead of yours and
                          cannot stack tabs in your browser — it stays up on
                          purpose, close it yourself. \`isolated\` always,
                          \`current\` never (the pre-\`--display\` behaviour, for
                          both halves), \`:N\` a display you manage.
                          AIO_AM_DISPLAY=<what> sets it machine-wide.
  kill                    End it now, no asking (SIGTERM + drop the lock)
  kill --stale            Reap ORPHANS — processes still SERVING with no lock
                          to account for them. That is the one that answers
                          am state with old numbers while am status says
                          stopped. Add --port=N for an orphan on a port
                          nothing records.
  restart [component]     Stop + start (the whole project, or one component)
  watch [dir]             Hot-restart on .ts/.tsx change in dir (default: src/)
  status [component]      stopped|starting|started|stopping (exit 0=started,
                          1=stopped, 2=transitional). With components: one line
                          each, and the same three codes read over the whole
                          project — 0 every one up, 1 every one down, 2 partial.
  instances               List running aio apps in THIS scope — an instance or
                          AIO_APPS_DIR scope lists only its own apps

State:
  state [path] [--wait=N]  State query (dot-path, [*] wildcard, {pick})
  state <path> --watch    POLLS (every --wait=N s, default 2) and prints only
                          when the value differs from the last poll — the loop
                          you were about to write with \`until\`. A change
                          undone within one interval is not seen
  state --ui [user]       Server-side UI-state projection (was \`am ui\`; for
                          live client UI use: surface)
  expect <path> <op> [v]  ASSERT / TEST / verify state (eq/ne/gt/lt/contains/exists…);\n                          e2e; --wait=N — the check to reach for instead of\n                          piping \`am state\` through a parser
  record [out] [--from=J] GENERATE A TEST — writes a bootCells replay test from\n                          the RUNNING app's timeline, so a bug you reproduced\n                          becomes a test (app stopped: its crash journal;\n                          --from=J: that journal file)
  dispatch <cell:method> [a b …]  Call a method with POSITIONAL args (setHost "1.2.3.4")
  dispatch … --as-server  Dispatch past the cell access gate — the operator
                          door for a "public read, server-only write" cell.
                          Loopback-only, logged, dev-only (as the trojan is).
  dispatch <cell:method> --args='["1.2.3.4"]'  …the same, JSON-exact (values with '=', exact types)
  dispatch <Type> [k=v]   Dispatch a plain action with a named payload
  dispatch --body='{"type":...,"payload":...}'  Raw envelope (after a <Type>, --body is its payload)
  actions                 Time-travel history

Time-travel:
  timeline [--from=J]     DEBUG / trace: recent dispatches + payload + state diff\n                          (--lines=N) — what happened, and what it changed
  replay [N..M] [--dry]   REPRODUCE: re-dispatch a journal range (--from=J)
  timetravel undo|redo    Step back/forward
  timetravel goto <id>    Jump to one entry — the id am actions lists
  timetravel pause|resume Freeze/unfreeze state

Persistence:
  persist                 Force immediate persist
  snapshot                Dump state JSON to stdout
  snapshot save [file]    Save snapshot to file
  snapshot load <file>    Load snapshot from file (replaces ALL state;
                          --force to accept a different cell set)
  migrations              Cell versions (declared vs stored) + shape drift

Framework version:
  pin                     Which aio version this app builds against
  pin <version>           Switch to it (provisions + relinks + records it)
  pin main                Follow the branch tip (a moving target)
  pin latest              Pin the newest release (--latest is the same)

Manual labs (a REAL desktop or device you click around in — not a gate):
  lab windows             Boot Windows in a container, mount dist/, print the
                          viewer URL (first run installs: ~30 min, tens of GB)
  lab macos               The same for macOS (setup is partly MANUAL)
  lab linux               An Ubuntu XFCE desktop — a container, not a VM: no
                          KVM, no disk, up in seconds; dist/ is /shared inside
  lab android             The Android 14 emulator + viewer — needs /dev/kvm and
                          an APK in dist/; am waits for boot and adb-installs it
  lab <os> --status|--stop|--reset   up? / clean shutdown / delete the VM disk
                          Flags: --port=N --dist=<dir> --tunnel; VMs also
                          --ram=8G --cpus=4 --disk=64G --version=11;
                          android also --apk=<file>
                          See docs/testing/vm-labs.md — and note this is the
                          manual tier: \`deno task test:wine\` and
                          \`deno task lab\` are the automated ones.

Look:
  theme adopt             Take aio's stylesheet INTO this app (src/aio-theme.css)
                          — yours from then on: editable, in your git history,
                          and no aio upgrade can change it. Build ON the
                          default look without depending on the framework for it.

Files (~/.<app>/ — data/ is the whole backup):
  data                    Where this app keeps everything, and what to back up
  backup [dest]           Copy data/ to dest (stop the app first, or --force).
                          Default dest: ~/.<app>/backups/<app>-backup-<stamp>
  restore <dir>           Put a backup back (keeps the data it replaces)

Inspect:
  clients                 Connected WebSocket clients (with index)
  client <index>          Request component tree from client (dev mode)
  surface [clientIdx|server]  Semantic UI surface — every component + element, by name (server = headless render, no client needed)
  surface --full          …with untruncated element text (default caps at 80, marked with …)
  surface --component=X   only that component (every instance), with its subtree
  surface --path=A/B      only that subtree, by path prefix
  surface --depth=N       cap the tree depth (0 = the component alone)
  surface --rects         MEASURE the layout — x/y/w/h per element, so "it looks fine" becomes "the Stage is 6886px tall". Needs a real client; a server render refuses rather than report 0x0
  trigger <idx> <path> <action> [text]  Drive the live UI (click/type/setValue/press/keyDown/keyUp/hover/focus/blur/scroll) — same engine as testUI; path "window" drives an onGlobalKey binding
                          type APPENDS to the field, setValue REPLACES it (as in testUI)
  shot [n] [--out=F.png] [--full]  PNG of the live Electron window via CDP — the app
                          must run with --cdp (or AIO_CDP=1); --json → {file,bytes,url}
  shot --selector='<css>'  CROP the shot to one element (measured in the page,
                          so it is right after a scroll or a transform)
  shot --update=base.png   RECORD a visual baseline
  shot --check=base.png    ASSERT the UI still looks like that baseline — exits 1
                          and writes base.actual.png when it does not. Compares
                          PIXELS, not bytes, with a tolerance (--threshold=N per
                          channel, default 2; --max-diff=RATIO, default 0).
  shot --video[=F.mp4|.webm]  RECORD the window until Ctrl-C (or --duration=S),
                          then encode it in the window — no ffmpeg; the
                          extension picks H.264 MP4 or VP8 WebM
                          Deterministic state: am snapshot load, then am dispatch
  eval '<expression>'     Evaluate ONE JS expression in the live renderer, get
                          JSON back (statements: '(() => { …; return x })()') —
                          geometry, computed styles, a fetch from the page's own
                          origin: everything \`surface\` cannot see. Promises are
                          awaited. Needs --cdp, same as shot. --window=N picks
                          the window.
  preview <file> [--export=Name] [--props=JSON]  RENDER one component with props
                          you choose and print what it produces — an empty
                          state, an error card, a long name — without driving
                          the whole app into that state first. Same renderer as
                          \`surface\`, same \`Component:Element\` paths
  where <file>            Which execution context this file runs in, and WHY —
                          the import chain from the UI entry, from the same
                          module graph the dev server walks
  check                   Does the client graph BUILD? \`deno check\` type-checks
                          but does not bundle, and in aio those differ: a
                          server-only import into a cell type-checks and then
                          fails to build. Scaffolded into \`deno task check\`
  --instance=<name>       (global) run and address a PRIVATE copy: its own
                          lock, data home and logs, beside anyone else's.
                          An agent and a human stop sharing one session
  testgen [entry] [--out=F]  GENERATE A TYPED TEST CLIENT from what the app actually renders — ui.App.SaveButton.click() autocompletes and a renamed button breaks tests at COMPILE time, instead of a string key whose typo is a runtime undefined. Re-run after a UI change (default out: tests/ui.gen.ts)
  feedback [app]          Where THIS app's findings about aio go — a stable
                          path outside the version store, so \`am pin\` and
                          pruning an old version cannot delete them. Report,
                          file a bug, log a rough edge, suggest an improvement.
                          --create starts the file from a template
  sql <query>             Execute read-only SQL
  sql --tables            List SQLite tables
  tables                  The same list under its own name (= sql --tables)
  schedules               Active scheduled effects
  logs [filter]           Tail app log; a filter is a substring, e.g. "am logs error"
                          (--client --filter --lines --follow --level --tag --since)
                          --lines=N counts EVENTS; --json .matched is the
                          health-check count (.total keeps unreadable lines)
                          keeps error events
  errors                  What went wrong: the build error (if any) first,
                          then the tail of error.log (--lines=N)
  metrics                 Uptime, connections, schedules
  cost                    Bytes pushed/s, per cell and per key, + reduce p95
  cost --keys             …every key, not just the top three
  cost --cell=X           …one cell
  cost --window=5m        …over a different window (default 60s)
  heap                    What the process HOLDS: heap vs the V8 ceiling, RSS,
                          and serialized cell-state sizes. \`am state\` says what
                          it SERVES; this says what it is holding on to
  top [secs]              Live runtime view (per-cell state sizes); --json = one shot
  health                  HTTP health check
  doctor                  DIAGNOSE running process vs dep/aio on disk (→ am restart),
                          and each multi-source setting with who decided it
                          (flag / config / deno.json / env / default).
                          Not config checks (\`deno task doctor\`), not migrate.
  open [--print]          Open THIS app in a browser (--print writes the URL)
  discover [--timeout=ms] Find exposed aio apps on the LAN (UDP broadcast)
  profile [--out=file]    Export this app's .aioapp profile (cert + key) for the client
  pair                    Fresh single-use pairing PIN (3 min) — no restart needed
  trust                   Show this machine's aio root + how to install it, so
                          browsers stop warning about EVERY aio app (one
                          install, all apps, forever). Name-constrained: it can
                          only vouch for localhost/.local/LAN, never the public
                          web. \`am trust path\` prints just the file.
  config                  Server configuration

Scaffold:
  add cell <name>         Generate src/cell/<name>.ts
  add server <name>       SCAFFOLD A SERVER-ONLY module: src/server/<name>.server.ts
                          (serverFns) AND the import line that registers it —
                          a namespace nobody imports is registered nowhere

Diagnose / repair / migrate (three different questions — do not conflate):
  doctor                  running process vs aio on disk? + who decided each setting
  fix                     clone/checkout repair: symlink, env, electron, tasks
                          (--dry-run / --no-download). Not an API migrator.
  link                    Just the dep/aio symlink (fix does this and more)
  migrate [--from=X]      which retired APIs THIS app still uses (CI exits 1).
                          Rewrites: aiol --safe-fix. Not a clone repairer.

Auth (apps running with auth: true) — run "am auth" for all of them:
  auth users              List accounts
  auth create <id>        Add one (prints a generated password if none given)
  auth passwd <id>        Set a password (also clears the lockout + sessions)
  auth unlock <id>        Clear a lockout
  auth totp <id> off      Clear the second factor (lost device)
  auth role <id> <role>   Change a user's role
  auth verify <id>        Mark an account's email verified
  auth revoke <id>        Revoke every session of a user
  auth rm <id>            DELETE a user and everything it holds

Feedback:
  report                  Collect a problem report (logs + versions + state
                          shape) for an app configured with feedback: true

Install (apps that run.sh installed into ~/app/):
  installed               List them, with version + where each came from
  upgrade <app>           Rebuild and reinstall from its recorded source
                          (a bare "am upgrade" updates am itself)
  remove <app> [--data]   Uninstall one — the PROGRAM; --data also deletes
                          ~/.<app>/ (state, logs, keys — it does not come back)

Other:
  version                 Print version
  help                    This message

Driving an app with no human in the loop (agents, CI, scripts): ASSERT with
        expect, DRIVE with dispatch, READ the UI with surface, DEBUG with
        timeline, REPRODUCE with replay. Run "am agent" for all of it at once
        (docs/AGENTS.md is the long form) — three field reports finished a
        whole build before finding these verbs.

--json: machine-readable output for EVERY command — the scripting interface
        (errors included; a non-zero exit still means failed)

Flags: --app=X  --port=N  --entry=<path>  --wait[=N]  --no-wait  --json  --quiet  --body='{...}'  --args='[...]'  --filter=X  --lines=N  --follow/-f  --transport=ws|uds  --client-index=N/-i N  --all  --home=<dir>  --timeout=<ms>

--app: target specific app by ID (default: resolved from deno.json name)
--home: target the instance of that app running from <dir> (an isolated
        second boot); AIO_APPS_DIR is the env-level equivalent
--timeout: ms to wait for a live client (surface/trigger; default 8000)
--entry: override entry point (default: deno.json "entry" > src/app.ts)
--wait: start/stop block until complete (start 10s, stop 11s) — start does this by
        default; --no-wait returns the moment the child is spawned.
        state polls every Ns.`;

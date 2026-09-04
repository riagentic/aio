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
export const TEMPLATES = ["counter", "todo", "cli"] as const;
export type Template = (typeof TEMPLATES)[number];

export const HELP_TEXT = `Onboard:
  create <name> [--template=${
  TEMPLATES.join("|")
}]  Scaffold a new aio app (runnable + buildable)
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
                          --expose --port=N). \`am start\` is the supervised
                          background form: lock, health wait, am stop/status

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
  instances               List all running aio apps on this machine

State:
  state [path] [--wait=N]  State query (dot-path, [*] wildcard, {pick})
  state --ui [user]       Server-side UI-state projection (was \`am ui\`; for
                          live client UI use: surface)
  expect <path> <op> [v]  Assert on state (eq/ne/gt/lt/contains/exists…); e2e; --wait=N
  record [out] --from=J  Generate a bootCells replay test from a journal
  dispatch <cell:method> [a b …]  Call a method with POSITIONAL args (setHost "1.2.3.4")
  dispatch … --as-server  Dispatch past the cell access gate — the operator
                          door for a "public read, server-only write" cell.
                          Loopback-only, logged, dev-only (as the trojan is).
  dispatch <cell:method> --args='["1.2.3.4"]'  …the same, JSON-exact (values with '=', exact types)
  dispatch <Type> [k=v]   Dispatch a plain action with a named payload
  dispatch --body='{"type":...,"payload":...}'  Raw envelope (after a <Type>, --body is its payload)
  actions                 Time-travel history

Time-travel:
  timeline [--from=J]     Recent dispatches + payload + state diff (--lines=N)
  replay [N..M] [--dry]   Re-dispatch a journal range for repro (--from=J)
  timetravel undo|redo    Step back/forward
  timetravel goto <N>     Jump to index
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
  trigger <idx> <path> <action> [text]  Drive the live UI (click/type/setValue/press/keyDown/keyUp/hover/focus/blur/scroll) — same engine as testUI; path "window" drives an onGlobalKey binding
                          type APPENDS to the field, setValue REPLACES it (as in testUI)
  shot [n] [--out=F.png] [--full]  PNG of the live Electron window via CDP — the app
                          must run with --cdp (or AIO_CDP=1); --json → {file,bytes,url}
  where <file>            Which execution context this file runs in, and WHY —
                          the import chain from the UI entry, from the same
                          module graph the dev server walks
  sql <query>             Execute read-only SQL
  sql --tables            List SQLite tables
  tables                  The same list under its own name (= sql --tables)
  schedules               Active scheduled effects
  logs [filter]           Tail app log (--client for client.log) (--filter --lines --follow)
                          A filter is a substring, e.g. "am logs error"
                          keeps error events
  errors                  What went wrong: the build error (if any) first,
                          then the tail of error.log (--lines=N)
  metrics                 Uptime, connections, schedules
  cost                    Bytes pushed/s, per cell and per key, + reduce p95
  cost --keys             …every key, not just the top three
  cost --cell=X           …one cell
  cost --window=5m        …over a different window (default 60s)
  top [secs]              Live runtime view (per-cell state sizes); --json = one shot
  health                  HTTP health check
  doctor                  running instances vs dep/aio on disk (fix: am restart)
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

Repair (a clone that does not run yet):
  fix                     Full repair: dep/aio symlink, env, electron, config,
                          tasks — the one to run after a git clone.
                          --dry-run reports without writing; --no-download
                          skips the network steps (Electron, deno cache)
  link                    Just the dep/aio symlink (fix does this and more)

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

--json: machine-readable output for EVERY command — the scripting interface
        (errors included; a non-zero exit still means failed)

Flags: --app=X  --port=N  --entry=<path>  --wait[=N]  --no-wait  --json  --quiet  --body='{...}'  --args='[...]'  --filter=X  --lines=N  --follow/-f  --transport=ws|uds  --client-index=N/-i N  --all  --home=<dir>  --timeout=<ms>

--app: target specific app by ID (default: resolved from deno.json name)
--home: target the instance of that app running from <dir> (an isolated
        second boot); AIO_APPS_DIR is the env-level equivalent
--timeout: ms to wait for a live client (surface/trigger; default 8000)
--entry: override entry point (default: deno.json "entry" > src/app.ts)
--wait: start/stop block until complete (default 10s/5s) — start does this by
        default; --no-wait returns the moment the child is spawned.
        state polls every Ns.`;

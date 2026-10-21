/**
 * @module
 * Service files — the systemd unit, launchd plist and Windows scheduled-task
 * script a server build writes beside its binary. Split out of
 * build-compile.ts, which re-exports every name here, so no importer changes.
 */

import { join } from "@std/path";
import { artifactName } from "./platforms.ts";
import { BUILD_VERSION_ENV } from "../server/app-version.ts";
import { DEFAULT_PORT_ENV } from "../server/aio-cli.ts";
import type { BuildConfig } from "./build-config.ts";
import { HEY } from "../diagnostics/fmt.ts";
import { compiled } from "./build-say.ts";

/** Runtime flags for the generated systemd unit.
 *
 *  These MUST be flags the compiled binary actually parses — a unit is copied
 *  verbatim into /etc/systemd/system, so a wrong flag is only discovered as a
 *  crash loop on the user's server. `--headless` is a BUILD flag with no
 *  runtime counterpart; the runtime spelling for "server, no UI" is
 *  `--client=server-only`. Shipping `--headless` meant the service started in
 *  the default (electron) client mode instead. Pure, so the unit's contract is
 *  unit-testable against the CLI's known flags. */
export function serviceExecFlags(
  opts: { doRemote: boolean; doHeadless: boolean; port?: number },
): string[] {
  // No invented default. `--port=3000` was written into every unit that named
  // no port, and `--port` outranks everything (`--port` > `AIO_PORT` >
  // `aio.run({ port })`), so an app that declared `port: 8123` was installed
  // as a service on 3000 — its clients, configured for 8123, found nothing.
  // Without the flag the runtime's own chain decides, exactly as it does when
  // the binary is started by hand.
  const flags = opts.port !== undefined ? [`--port=${opts.port}`] : [];
  if (opts.doRemote) flags.push("--expose");
  if (opts.doHeadless) flags.push("--client=server-only");
  return flags;
}

/** What a service unit binds when neither `build.server` nor the app names a
 *  port — the number every unit said before it stopped pinning one, so an
 *  installed fleet's clients keep finding it. */
const SERVICE_DEFAULT_PORT = 3000;

/** The port a service unit should pin: the one `build.server` names
 *  explicitly (`relay.example:8443`), else undefined — the unit then leaves
 *  the port to the runtime. `build.server` is where the clients of this build
 *  were told the server listens, so a service that bound anything else would
 *  ship a fleet that cannot reach itself. A scheme's default port (`https://x`)
 *  names none: `URL.port` is empty for it. */
export function servicePort(
  bakedServer: string | null | undefined,
): number | undefined {
  if (!bakedServer) return undefined;
  const p = new URL(bakedServer).port;
  return p ? Number(p) : undefined;
}

/** A value safe to follow `Key=` in a unit that expands specifiers.
 *
 *  `%` starts a specifier in `Description=`, `User=` and `Environment=`
 *  (`%h`, `%n`…), so a title or a path with a literal `%` was silently
 *  rewritten by systemd, or refused as an unknown specifier. */
export function systemdSpecifierEscape(v: string): string {
  return v.replace(/%/g, "%%");
}

/** One `Environment=` assignment, quoted the way systemd reads it.
 *
 *  Unquoted, the value ends at the first space: `Environment=HOME=/home/a b`
 *  is two assignments, and `b` is not one — `systemd-analyze verify` reports
 *  "Invalid environment assignment" and the variable is never set, so the app
 *  resolved its data directory from no `HOME` at all. Inside double quotes
 *  systemd applies C-style unescaping, so `\` and `"` are escaped; control
 *  characters are flattened (a newline would start a new directive). */
export function systemdEnvAssignment(key: string, value: string): string {
  const inner = systemdSpecifierEscape(`${key}=${value}`)
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `Environment="${inner}"`;
}

/** What the three supervisor files share: the binary, what to call it, the
 *  runtime flags ({@linkcode serviceExecFlags} — one decider for all three)
 *  and, when no port is pinned, the stable default the systemd unit carries. */
type SupervisorOpts = {
  binaryName: string;
  title: string;
  flags: string[];
  defaultPort?: number;
};

/** Text safe inside an XML element. */
function xmlText(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The loop a launchd job runs instead of the binary itself, as `sh -c` text.
 *
 *  launchd cannot say "every exit code but 143": `KeepAlive` true starts the
 *  app again after `aio.stop()` and `am stop` too. So the job is this loop —
 *  it starts the app again after any exit but 143, and ends with 0 on 143 —
 *  under `KeepAlive: { SuccessfulExit: false }`, which starts the LOOP again
 *  only if it died. `launchctl bootout` sends SIGTERM to the job's process,
 *  which is the loop: it passes the signal on (a clean stop for the app),
 *  waits for the app to finish, and ends. Without the trap the shell would
 *  die at once and launchd would kill the app behind it.
 *  @internal exported for its test */
export const LAUNCHD_LOOP = [
  `trap 'stop=1; kill -TERM "$p" 2>/dev/null' TERM INT`,
  `while :; do`,
  `  "$@" & p=$!`,
  `  wait "$p"; c=$?`,
  // A trapped signal interrupts `wait`: wait again for the app's real exit.
  `  while kill -0 "$p" 2>/dev/null; do wait "$p"; c=$?; done`,
  `  [ -n "$stop" ] && exit 0`,
  `  [ "$c" -eq 143 ] && exit 0`,
  `  sleep 5`,
  `done`,
].join("\n");

/** A launchd agent for a `server` binary built for macOS — the systemd unit's
 *  contract in launchd's terms. Pure.
 *  @internal exported for its test */
export function launchdPlist(o: SupervisorOpts): string {
  const str = (v: string) => `    <string>${xmlText(v)}</string>`;
  const env = [
    ["AIO_SUPERVISED", "1"],
    // `am stop` stays down, as `aio.stop()` does (see the systemd unit).
    ["AIO_STOP_STAYS_DOWN", "1"],
    ...(o.defaultPort !== undefined
      ? [[DEFAULT_PORT_ENV, String(o.defaultPort)]]
      : []),
  ].map(([k, v]) =>
    `    <key>${xmlText(k!)}</key>\n    <string>${xmlText(v!)}</string>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  ${
    xmlText(o.title).replaceAll("--", "- -")
  } (aio): a launchd agent that keeps the server running.

  Install:
    sudo cp <the macOS binary beside this file> /usr/local/bin/${o.binaryName}
    cp <this file> ~/Library/LaunchAgents/app.aio.${o.binaryName}.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.aio.${o.binaryName}.plist
  Stop and unload (a clean stop):
    launchctl bootout gui/$(id -u)/app.aio.${o.binaryName}

  The job is a small loop, because launchd cannot tell exit codes apart:
    exit 0   (an update, aio.restart())   started again
    exit 143 (aio.stop(), am stop)        stays down until the next login
    anything else (a crash)               started again after 5 s
  AIO_SUPERVISED=1 tells the app it is supervised, so it EXITS after an update
  instead of starting its own successor. AIO_STOP_STAYS_DOWN=1 makes am stop
  exit 143 (without it am stop exits 0 and the app is started again).${
    o.defaultPort !== undefined
      ? `
  No port is pinned in the arguments: the app's own port wins (aio.run({ port })
  or AIO_PORT). ${DEFAULT_PORT_ENV} is only what it binds when it declares none.`
      : ""
  }
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.aio.${xmlText(o.binaryName)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
${str(LAUNCHD_LOOP)}
    <string>aio-supervise</string>
${str(`/usr/local/bin/${o.binaryName}`)}
${o.flags.map(str).join("\n")}${o.flags.length ? "\n" : ""}  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
`;
}

/** A PowerShell single-quoted literal. */
function psQuote(s: string): string {
  // deno-lint-ignore no-control-regex
  return `'${s.replace(/[\u0000-\u001f\u007f]/g, " ").replaceAll("'", "''")}'`;
}

/** The supervisor of a `server` binary built for Windows: one PowerShell 5.1
 *  script that IS the restart loop (Task Scheduler cannot tell exit codes
 *  apart) and registers itself as a logon task with `-Install`. Pure.
 *  @internal exported for its test */
export function windowsTaskScript(o: SupervisorOpts): string {
  const name = o.binaryName;
  const title = o.title.replace(/[\r\n]+/g, " ");
  const flags = o.flags.map(psQuote).join(" ");
  return `# ${title} (aio): keeps the server running under Windows Task Scheduler.
#
# Task Scheduler cannot tell exit codes apart, so the loop at the end of this
# script is the supervisor and the task only starts it at logon:
#   exit 0   (an update, aio.restart())   started again
#   exit 143 (aio.stop(), am stop)        stays down until the next logon
#   anything else (a crash)               started again after 5 s
#
# Install - once, in an ADMINISTRATOR PowerShell (a logon task needs one):
#   powershell -ExecutionPolicy Bypass -File .\\${name}.ps1 -Install -Exe C:\\path\\to\\${name}.exe
# -Exe defaults to where run.ps1 installs an app. A copy of this script is put
# beside the .exe and the task runs that copy, so this folder can go.
# Stop it:   am stop --app=${name}     (a clean stop; the task then ends)
# Remove it: powershell -ExecutionPolicy Bypass -File .\\${name}.ps1 -Uninstall
param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$Exe = (Join-Path $env:LOCALAPPDATA ${
    psQuote(`Programs\\${name}\\${name}.exe`)
  })
)
$Task = ${psQuote(name)}

if ($Uninstall) {
  # Stop-ScheduledTask ends the process tree the hard way: stop the app with
  # "am stop" first when its last write matters.
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction Stop
  Write-Host "removed the scheduled task '$Task' (the app and its data are untouched)"
  exit 0
}

if ($Install) {
  $ErrorActionPreference = 'Stop'
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
    Write-Host "no program at $Exe - copy the .exe there, or pass -Exe <path>"
    exit 1
  }
  $Exe = (Resolve-Path -LiteralPath $Exe).Path
  $self = Join-Path (Split-Path -Parent $Exe) ${
    psQuote(`${name}-supervise.ps1`)
  }
  if ($PSCommandPath -ne $self) { Copy-Item -LiteralPath $PSCommandPath -Destination $self -Force }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Exe "{1}"' -f $self, $Exe)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # Without these Task Scheduler ends a task after three days and does not
  # start it on battery.
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Description ${
    psQuote(`${title} (aio)`)
  } -Force | Out-Null
  Start-ScheduledTask -TaskName $Task
  Write-Host "registered and started the scheduled task '$Task' - it runs $Exe at every logon"
  exit 0
}

# Tells the app it is supervised, so it EXITS after an update instead of
# starting its own successor (two processes fighting over one app lock).
$env:AIO_SUPERVISED = '1'
# am stop exits 143 and stays down, as aio.stop() does (without this line it
# exits 0 and the loop starts the app again).
$env:AIO_STOP_STAYS_DOWN = '1'
${
    o.defaultPort !== undefined
      ? `# No --port below: the app's own port wins (aio.run({ port }), or AIO_PORT).
# This is only what it binds when it declares none - without it a restart
# would come up on a different random port.
$env:${DEFAULT_PORT_ENV} = '${o.defaultPort}'
`
      : ""
  }do {
  & $Exe ${flags}
  $code = $LASTEXITCODE
  if ($code -ne 143) { Start-Sleep -Seconds 5 }
} while ($code -ne 143)
`;
}

/** Write a systemd .service unit file for the compiled binary. */
export async function writeServiceFile(cfg: BuildConfig): Promise<void> {
  const { binaryName, appTitle, doRemote, doHeadless } = cfg;
  // The artifact on disk is `binaryName` only on the host platform; a
  // cross-compiled server target ships `binaryName-<platform>`, and a unit
  // that said `cp binaryName` named a file the build never produced — a
  // service that fails on the target's first boot, the one place the
  // operator is not watching. The unit is installed under the plain name,
  // so ExecStart keeps it; only the copy's SOURCE is the artifact.
  const artifact = artifactName(binaryName, cfg.platform);
  // systemd is Linux-only: a unit for a Windows .exe or a Mach-O binary names
  // an install path that host does not have. Written anyway, every platform's
  // unit was `<name>.service`, so `--platforms=host,windows` on a server
  // target collided in the fleet's dist/ and the whole build died after
  // compiling everything.
  // Those two get the supervisor file THEIR OS has — the same contract in
  // another spelling: `AIO_SUPERVISED=1`, start again after any exit but 143.
  if (cfg.os === "windows" || cfg.os === "darwin") {
    const port = servicePort(cfg.bakedServer);
    const o = {
      binaryName,
      title: appTitle || binaryName,
      flags: serviceExecFlags({ doRemote, doHeadless, port }),
      defaultPort: port === undefined ? SERVICE_DEFAULT_PORT : undefined,
    };
    const file = join(
      cfg.outDir ?? cfg.root ?? ".",
      cfg.os === "darwin"
        ? `${artifact}.plist`
        : `${artifact.replace(/\.exe$/i, "")}.ps1`,
    );
    await Deno.writeTextFile(
      file,
      // A BOM for the script: Windows PowerShell 5.1 reads a file without
      // one in the ANSI code page, and the title may be any text.
      cfg.os === "darwin" ? launchdPlist(o) : `\uFEFF${windowsTaskScript(o)}`,
    );
    compiled(file, cfg.root ?? Deno.cwd());
    return;
  }
  // BUILD-MACHINE IDENTITY, and the unit is copied verbatim to a server.
  //
  // `User=` and `HOME=` were taken from the build environment and written as
  // though they were facts about the target. They are not: build as `dev`,
  // install on a host with no `dev` account, and systemd refuses the unit with
  // "Failed to determine user credentials". Same class as a compiled binary
  // serving `<cwd>/src` — a value that was true where the command was TYPED,
  // applied to a machine that lives somewhere else.
  //
  // The `?? "root"` was the dangerous half. A build with no `$USER` — a
  // container, a CI runner, i.e. the normal release pipeline — silently
  // emitted `User=root`, so the operator's service ran the app as root
  // because of where it was BUILT. aio does not know who should run this
  // service and must not guess; the placeholder fails the unit closed, with a
  // name that says what to do, which is the safe direction to be wrong in.
  const buildUser = Deno.env.get("USER");
  const user = buildUser ?? "REPLACE-ME";
  const home = Deno.env.get("HOME") ?? `/home/${user}`;
  if (!buildUser) {
    console.warn(
      `${HEY} this build has no $USER, so the generated ${binaryName}.service ` +
        `cannot name the account to run as. It carries \`User=REPLACE-ME\`, ` +
        `which systemd refuses until you set it — deliberately, rather than ` +
        `defaulting to root because of how the build was run.`,
    );
  }
  // `?? "."` keeps a hand-built config (a test, a custom script) writing into
  // the cwd exactly as it did before --out= existed.
  // Named like the binary it runs: a cross-built `linux-arm64` unit beside
  // the host's is `<name>-linux-arm64.service`, not a second `<name>.service`.
  const serviceFile = join(
    cfg.outDir ?? cfg.root ?? ".",
    `${artifact}.service`,
  );
  const port = servicePort(cfg.bakedServer);
  const execFlags = serviceExecFlags({ doRemote, doHeadless, port });
  // With no port of its own to pin, the unit still owes the service a STABLE
  // one. Leaving it to the runtime alone bound a fresh random port on every
  // restart (:49167, then :57074 — no client finds that twice), and `--port`
  // or `AIO_PORT` would outrank a declared `aio.run({ port })` again. The
  // chain's bottom rung (`envDefaultPort`) is the one that says "this, unless
  // the app declares its own".
  const defaultPortLine = port === undefined
    ? `# No --port above: the app's own port wins (aio.run({ port }), or
# AIO_PORT). This is only what it binds when it declares none — without it a
# restart would come up on a different random port.
${systemdEnvAssignment(DEFAULT_PORT_ENV, String(SERVICE_DEFAULT_PORT))}
`
    : "";
  if (port === undefined) {
    console.warn(
      `${HEY} ${artifact}.service names no --port: the service binds the ` +
        `port the app declares (aio.run({ port }) or $AIO_PORT), and ` +
        `${SERVICE_DEFAULT_PORT} when it declares none ` +
        `(${DEFAULT_PORT_ENV}=${SERVICE_DEFAULT_PORT} in the unit). To pin ` +
        `it, set "build": { "server": "host:port" } in deno.json, or edit ` +
        `that line.`,
    );
  }
  // systemd units are line-oriented: a newline in the title starts a new
  // DIRECTIVE. `"title": "My App\nExecStart=/bin/sh -c '…'\nUser=root"` in
  // deno.json therefore wrote a unit that ran something else, as root, on the
  // machine the operator installs it on. `binaryName` is slugified;
  // `appTitle` is free text and must be flattened the same way
  // build-electron.ts already flattens displayName for .desktop files.
  //
  // `--name=` first: it is how a per-target `name` reaches this build, and a
  // `relay` target's unit read `Description=spapp (aio)` — the PROJECT's
  // title, on the unit of a different app. A per-target `title`
  // (`--display-name=`) is already `appTitle` and wins over both.
  const named = Deno.args.find((a) => a.startsWith("--name="))?.slice(7);
  const hasDisplay = Deno.args.some((a) => a.startsWith("--display-name="));
  const safeTitle = ((hasDisplay && appTitle) || named || appTitle ||
    binaryName).replace(
      // deno-lint-ignore no-control-regex
      /[\u0000-\u001f\u007f]/g,
      " ",
    ).trim();
  // COMMENTS ON THEIR OWN LINES, never after a directive. systemd has no
  // trailing-comment syntax: a `#` after `ExecStart=` is part of the command
  // line, so `# adjust path after install` shipped as FIVE extra argv words
  // (`#`, `adjust`, `path`, `after`, `install`) to every service the build
  // wrote, and `RestartPreventExitStatus=143   # aio.stop() …` made systemd log
  // "Failed to parse value, ignoring: #" six times on every daemon-reload
  // (measured with `systemd-analyze verify`, systemd 255). aio's own parser
  // passes bare words through to the app, so the service booted and nothing
  // said the unit was wrong — a broken file that happens to work.
  const unit = `[Unit]
Description=${systemdSpecifierEscape(safeTitle || binaryName)} (aio)
After=network.target

[Service]
Type=simple
# Adjust the path after install (sudo cp ${artifact} /usr/local/bin/${binaryName}).
ExecStart=/usr/local/bin/${binaryName} ${execFlags.join(" ")}
# Restart=always, not on-failure: an aio app that updates ITSELF stops with a
# clean exit code 0 on purpose, so the supervisor starts the new binary. Under
# on-failure systemd treats that as "it meant to stop" and leaves the service
# DOWN — every successful auto-update took the app offline until someone
# noticed.
Restart=always
# aio.stop() exits 143 to stay down.
RestartPreventExitStatus=143
RestartSec=5
# BUILD-MACHINE VALUE — this came from the machine that built the binary, not
# from the host you are installing on. Set it to the account this service
# should run as (aio has no way to know, and will not guess).
User=${systemdSpecifierEscape(user)}
# Tells the app it is supervised, so it EXITS after an update instead of
# spawning its own successor (two processes fighting over one app lock). systemd
# sets INVOCATION_ID, which aio also honours; this is the explicit spelling for
# any other supervisor.
Environment=AIO_SUPERVISED=1
# \`am stop\` exits 0, so Restart=always starts the app again after RestartSec
# (as under every unit aio has generated); \`systemctl stop\` is the stop that
# holds. Uncomment to make \`am stop\` stay down too — it then exits 143:
#Environment=AIO_STOP_STAYS_DOWN=1
${defaultPortLine}# Also a build-machine value — the app's data directory hangs off it.
${systemdEnvAssignment("HOME", home)}

[Install]
WantedBy=multi-user.target
`;
  await Deno.writeTextFile(serviceFile, unit);
  // Under the fleet this path is STAGED — it is moved to
  // `dist/<name>-<version>.service` next — so it must not read as the
  // artifact (`✓ …/app.service` named a file gone by the build's end). The
  // one "this file now exists" line says which of the two it is.
  compiled(serviceFile, cfg.root ?? Deno.cwd());
  // Under the fleet (every CLI build) these files are about to be renamed into
  // `dist/` as `<name>-<version>…`, so steps naming them here would name files
  // that no longer exist — the fleet prints them after placement instead
  // (`placeServiceUnit` in build-all.ts).
  if (Deno.env.get(BUILD_VERSION_ENV) !== undefined) return;
  console.log(`
  Install:
    sudo cp ${artifact} /usr/local/bin/${binaryName}
    sudo cp ${serviceFile} /etc/systemd/system/${binaryName}.service
    sudo systemctl enable --now ${binaryName}

  Manage:
    sudo systemctl status ${binaryName}
    journalctl -u ${binaryName} -f
`);
}

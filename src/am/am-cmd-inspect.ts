/**
 * @module
 * Inspection commands for am — clients, click, sql, log, errors, metrics, health, etc.
 */

import { join } from "@std/path";
import { appDirs } from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, formatUptime, out, outError } from "./am-output.ts";
import {
  amCtx,
  parseNumArg,
  resolveAmAppId,
  resolvePort,
  runTrojanGet,
} from "./am-utils.ts";
import {
  FETCH_TIMEOUT,
  httpGet,
  resolveControlPort,
  trojanGet,
  trojanPost,
} from "./am-http.ts";

// ── Constants ───────────────────────────────────────────────

/** THE resolver for "which file does `am log` read" — one function, so the CLI
 *  cannot look somewhere no aio version writes.
 *
 *  - default: raw stdout+stderr of the app `am` launched —
 *    `~/.<appId>/logs/stdout.log` since alpha38 (it was `<project>/.aio.log`,
 *    which put half of one app's output in the project and half in the app dir).
 *  - `--client`: forwarded browser/Electron console output. The server writes it
 *    through `src/server/client-log.ts` into the ACTIVE LOGGER'S directory,
 *    i.e. `~/.<appId>/logs/client.log` (`.aio/log/client.log` before alpha38).
 *    `am` used to carry its own literal `"log/client.log"` — a relative path no
 *    aio version has ever written — so `am log --client` answered "(no client
 *    log yet)" for every app that has ever existed, and exited 0 doing it.
 *
 *  The pre-alpha38 path is still read so `am log` works against an app that is
 *  still running from before the move. Returns the CURRENT path when neither
 *  exists, so the error names where a running app would have put it. */
export function logPathFor(flags: GlobalFlags): string {
  const client = flags.client !== undefined;
  const current = join(
    appDirs(resolveAmAppId(flags.app)).logs,
    client ? "client.log" : "stdout.log",
  );
  const legacy = client ? join(".aio", "log", "client.log") : ".aio.log";
  for (const p of [current, legacy]) {
    try {
      Deno.statSync(p);
      return p;
    } catch { /* try the next one */ }
  }
  return current;
}

// ── Client commands ─────────────────────────────────────────

export async function cmdClients(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  await runTrojanGet(amCtx(flags), "clients");
}

export async function cmdClient(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const idx = args[0];
  if (idx === undefined) {
    outError(
      "usage: am client <index> — request client-side state (dev mode)",
      mode,
    );
    Deno.exit(1);
  }
  const result = await trojanGet(port, `client/${idx}`, appId, 10_000);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

// ── Database commands ───────────────────────────────────────

/** `am sql --tables` — the table list, which is one fixed query. `am tables`
 *  is the same thing under its own name; the flag is the canonical spelling
 *  because it composes with the rest of `sql` (`--json`, `--app`) instead of
 *  being a second command to remember. */
export async function cmdSql(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const query = args.includes("--tables") || flags.tables
    ? "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    : args.filter((a) => !a.startsWith("--")).join(" ");
  if (!query) {
    outError("usage: am sql <query>   ·   am sql --tables", mode);
    Deno.exit(1);
  }
  const result = await trojanPost(port, "sql", { query }, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

export async function cmdTables(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanPost(port, "sql", {
    query: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  }, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const rows = result.data as { name: string }[];
  if (mode === "pretty") {
    if (rows.length === 0) console.log("no tables");
    else rows.forEach((r) => console.log(r.name));
  } else {
    out(rows.map((r) => r.name), mode);
  }
}

// ── Observability commands ──────────────────────────────────

export async function cmdSchedules(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  await runTrojanGet(amCtx(flags), "schedules");
}

export async function cmdLog(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);

  // ONE tail for both files. `--client` used to run a SECOND, hand-written
  // implementation that ignored the output mode entirely (raw `console.log`
  // even under `--json`, so the documented `am log --client --json | jq …`
  // could never parse), polled instead of watching, and read a path of its own
  // invention. Two tails meant two answers to "what does `am log` print"; the
  // flag now only picks the file.
  const LOG_FILE = logPathFor(flags);

  const filter = args[0] ?? flags.filter;
  const n = flags.lines ?? 50;
  const follow = flags.follow ?? false;

  // Print current tail
  let offset = 0;
  try {
    const content = Deno.readTextFileSync(LOG_FILE);
    let lines = content.split("\n");
    if (filter) {
      const lc = filter.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(lc));
    }
    const tail = lines.slice(-n);
    if (mode === "json") {
      // deno-lint-ignore no-control-regex
      const clean = tail.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
      out({
        total: lines.length,
        shown: clean.length,
        filter: filter ?? null,
        lines: clean,
      }, mode);
    } else console.log(tail.join("\n"));
    offset = Deno.statSync(LOG_FILE).size;
  } catch {
    // Nothing to read. Without --follow that is a FAILURE, and it names the
    // path — "no log file found" named none, so an app whose data dir moved
    // (AIO_APPS_DIR / appDir) looked identical to an app that had never
    // logged, and the zero exit told a script both were fine.
    if (!follow) {
      fail(`no log file at ${LOG_FILE}`, mode);
    }
  }

  if (!follow) return;

  // --follow / -f: stream new bytes as they arrive (like tail -f). Deno.watchFs
  // throws on a path that does not exist yet, so wait for it — following a log
  // that has not had its first line written is the normal case for `--client`.
  while (true) {
    try {
      Deno.statSync(LOG_FILE);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const enc = new TextEncoder();
  const watcher = Deno.watchFs(LOG_FILE);
  let buf = "";
  for await (const event of watcher) {
    if (event.kind !== "modify" && event.kind !== "create") continue;
    try {
      // AIO-214: detect log rotation — reset offset if file shrunk
      const stat = await Deno.stat(LOG_FILE);
      if (stat.size < offset) offset = 0;
      // AIO-213: use try/finally to ensure file handle is always closed
      const file = await Deno.open(LOG_FILE, { read: true });
      try {
        await file.seek(offset, Deno.SeekMode.Start);
        const chunk = new Uint8Array(65536);
        let bytesRead: number | null;
        while ((bytesRead = await file.read(chunk)) !== null) {
          const text = new TextDecoder().decode(chunk.subarray(0, bytesRead));
          offset += bytesRead;
          buf += text;
          // Output complete lines; buffer partial last line
          const newline = buf.lastIndexOf("\n");
          if (newline === -1) continue;
          const toWrite = buf.slice(0, newline + 1);
          buf = buf.slice(newline + 1);
          const filtered = filter
            ? toWrite.split("\n").filter((l) =>
              l.toLowerCase().includes(filter.toLowerCase())
            ).join("\n") + "\n"
            : toWrite;
          if (filtered.trim()) await Deno.stdout.write(enc.encode(filtered));
        }
      } finally {
        file.close();
      }
    } catch { /* file rotated or removed */ }
  }
}

export async function cmdErrors(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await httpGet(port, "/__aio/error", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const text = (result.data as string).trim();
  // Server returns JSON { errors: [...] } or null/empty when no errors
  let errors: string[] = [];
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.errors)) errors = parsed.errors;
    else if (parsed === null) errors = [];
    else errors = [text]; // legacy: plain text error
  } catch {
    if (text) errors = [text]; // plain text fallback
  }
  // …and the RUNTIME errors, which is what the word means to the person
  // typing it. `/__aio/error` is the BUILD error — the thing that stops the
  // app from loading at all — so it comes first when present, but a command
  // called `errors` that stayed silent about error.log was answering a
  // narrower question than it was asked.
  const runtime = await tailErrorLog(appId, flags.lines ?? 20);

  if (mode !== "pretty") {
    // `errors` keeps meaning what it always meant — the BUILD errors — because
    // `--json` is the scripting interface and a key that changes meaning under
    // a script is worse than a missing one. `build` is its clearer name, and
    // `runtime` is the new half.
    out({ errors, build: errors, runtime }, mode);
    return;
  }
  if (errors.length === 0 && runtime.length === 0) {
    out("no errors — nothing in error.log, and the build is clean", mode);
    return;
  }
  const parts: string[] = [];
  if (errors.length > 0) {
    parts.push(`build (nothing else runs until this is fixed):`);
    parts.push(errors.join("\n"));
  }
  if (runtime.length > 0) {
    if (parts.length) parts.push("");
    parts.push(`runtime — last ${runtime.length} from error.log:`);
    parts.push(runtime.join("\n"));
  }
  out(parts.join("\n"), mode);
}

/** The tail of the app's own `error.log`. Absent file = no errors yet, which
 *  is different from "the app has no log directory" only in ways this command
 *  cannot act on — either way there is nothing to show. */
async function tailErrorLog(appId: string, lines: number): Promise<string[]> {
  try {
    const path = join(appDirs(appId).logs, "error.log");
    const text = await Deno.readTextFile(path);
    return text.split("\n").filter((l) => l.trim() !== "").slice(-lines);
  } catch {
    return [];
  }
}

export async function cmdMetrics(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "metrics", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const m = result.data as {
    uptime: number;
    connections: number;
    schedules: number;
  };
  if (mode === "pretty") {
    out(
      `uptime: ${
        formatUptime(m.uptime)
      }\nconnections: ${m.connections}\nschedules: ${m.schedules}`,
      mode,
    );
  } else {
    out(m, mode);
  }
}

// ── am top: live runtime observability ──────────────────────────

export type TopMetrics = {
  uptime: number;
  connections: number;
  schedules: number;
  cells: Record<string, number>;
};

/** Human-readable bytes; -1 = an unserializable (cyclic) cell slice. */
export function fmtBytes(n: number): string {
  if (n < 0) return "(cyclic)";
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

/** Render ONE `am top` frame — pure (no I/O), so it's unit-testable. Cells are
 *  sorted by serialized state size, descending (the "what's heavy" signal). */
export function renderTopFrame(m: TopMetrics, stamp = ""): string {
  const cells = Object.entries(m.cells ?? {}).sort((a, z) => z[1] - a[1]);
  const total = cells.reduce((s, [, n]) => s + Math.max(0, n), 0);
  return [
    `aio top${stamp ? `   ${stamp}` : ""}`,
    `  uptime ${formatUptime(m.uptime)}   clients ${m.connections}   ` +
    `schedules ${m.schedules}   cells ${cells.length}   state ${
      fmtBytes(total)
    }`,
    "",
    "  " + "CELL".padEnd(24) + "STATE".padStart(10),
    ...cells.map(([name, size]) =>
      "  " + name.padEnd(24) + fmtBytes(size).padStart(10)
    ),
  ].join("\n");
}

/** `am top` — live runtime view (pretty: refresh until Ctrl-C; json/quiet: one
 *  snapshot for scripting). Poll interval in seconds via the first arg. */
export async function cmdTop(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const fetchOnce = async (): Promise<TopMetrics | null> => {
    const r = await trojanGet(port, "metrics", appId);
    return r.ok ? (r.data as TopMetrics) : null;
  };

  if (mode !== "pretty") {
    const m = await fetchOnce();
    if (!m) {
      outError(`app not running on port ${port}`, mode);
      Deno.exit(1);
    }
    out(m, mode);
    return;
  }

  // A mistyped interval used to fall back to 1s via `|| 1` — the poll then
  // looked fine while ignoring what was asked for.
  const secArg = args.find((a) => !a.startsWith("--"));
  const secs = secArg === undefined
    ? { ok: true as const, value: 1 }
    : parseNumArg(secArg, "poll interval (seconds)", { min: 0.25 });
  if (!secs.ok) {
    outError(secs.error, mode);
    Deno.exit(1);
  }
  const intervalMs = Math.max(250, secs.value * 1000);
  const enc = new TextEncoder();
  let running = true;
  const stop = () => (running = false);
  Deno.addSignalListener("SIGINT", stop);
  try {
    while (running) {
      const m = await fetchOnce();
      const frame = m
        ? renderTopFrame(m, new Date().toLocaleTimeString())
        : `aio top — app not running on port ${port} (retrying…)`;
      await Deno.stdout.write(enc.encode("\x1b[2J\x1b[H" + frame + "\n"));
      if (!running) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    Deno.removeSignalListener("SIGINT", stop);
    await Deno.stdout.write(enc.encode("\n"));
  }
}

export async function cmdHealth(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const ctrlPort = resolveControlPort(port, appId);
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrlPort}/`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    await resp.body?.cancel();
    out(
      mode === "pretty"
        ? `healthy (${resp.status})`
        : { healthy: true, status: resp.status },
      mode,
    );
  } catch {
    out(mode === "pretty" ? "unreachable" : { healthy: false }, mode);
    Deno.exit(1);
  }
}

/** `am discover [--timeout=ms]` — list exposed aio apps on the LAN via UDP
 *  broadcast discovery (node:dgram — no flags needed).
 *  Shows each app's name, IP, port, ready URL, and whether auth is required. */
export async function cmdDiscover(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const { discoverAioApps } = await import("../server/discovery.ts");
  const tArg = args.find((a) => a.startsWith("--timeout="));
  // `--timeout=2s` is NaN, and NaN means a 1ms sweep that finds nothing and
  // then blames the network. Refuse it instead.
  const t = tArg === undefined
    ? { ok: true as const, value: 1500 }
    : parseNumArg(tArg.slice(10), "--timeout (ms)", { min: 1, integer: true });
  if (!t.ok) {
    outError(t.error, mode);
    Deno.exit(1);
  }
  const timeoutMs = t.value;
  const apps = await discoverAioApps({ timeoutMs });
  if (mode === "json") {
    out(apps, mode);
    return;
  }
  if (apps.length === 0) {
    out(
      "no aio apps found on the LAN.\n" +
        "  (apps must run with --expose; UDP is blocked on some networks — " +
        "type the address manually if you know it)",
      mode,
    );
    return;
  }
  const lines = apps.map((a) =>
    `  ${a.name}${a.title && a.title !== a.name ? ` (${a.title})` : ""}\n` +
    `    ${a.url}${a.needsAuth ? "  \u26bf auth required" : ""}`
  );
  const hint = apps.some((a) => a.needsAuth)
    ? "\n\u26bf apps pair by the 6-digit code they print at startup \u2014 enter it in " +
      "the aio client, or export a profile on the host with `am profile`."
    : "";
  console.log(
    `found ${apps.length} aio app(s) on the LAN:\n${lines.join("\n")}${hint}`,
  );
}

/** `am profile [--out=file]` — export the running app's discovery profile
 *  (.aioapp): name, port, TLS cert to pin, and auth key. Hand the file to a
 *  user; the aio client imports it once and connects forever. */
export async function cmdProfile(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const { buildLocalProfile } = await import("../server/profile.ts");
  const profile = buildLocalProfile(appId);
  if (!profile) {
    outError(
      `no running app "${appId}" found — start it (with --expose) first, ` +
        `or pass --app=<id>`,
      mode,
    );
    Deno.exit(1);
  }
  const outArg = args.find((a) => a.startsWith("--out="));
  if (outArg) {
    const file = outArg.slice(6);
    // 0600 — this file CONTAINS the app key, the forever credential that
    // grants raw state, arbitrary dispatch and SQL under --expose. The server
    // keeps that key 0600 inside a 0700 dir (app-key.ts); exporting it at the
    // default 0644 into $HOME or /tmp handed it to every local user.
    await Deno.writeTextFile(file, JSON.stringify(profile, null, 2), {
      mode: 0o600,
    });
    try {
      await Deno.chmod(file, 0o600); // pre-existing file: mode is not applied
    } catch { /* Windows / FS without modes */ }
    out(
      mode === "pretty" ? `wrote ${file}` : { ok: true, file },
      mode,
    );
    return;
  }
  out(profile, mode);
}

/** `am pair` — a FRESH pairing PIN from the running app.
 *
 *  A PIN is single-use and lives three minutes, and only the boot banner ever
 *  made one: miss that window and the only way to pair a device was to restart
 *  the app, i.e. drop every connected client. The app can mint one on request
 *  now that reaching its control plane means an admin or this machine's owner. */
export async function cmdPair(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const ctx = amCtx(flags);
  const r = await trojanPost(ctx.port, "pair", undefined, ctx.appId);
  if (!r.ok) {
    outError(r.error, ctx.mode);
    Deno.exit(1);
  }
  const d = r.data as { pin: string; ttlSec: number; hint: string };
  out(
    ctx.mode === "pretty" ? `pairing code: ${d.pin}\n${d.hint}` : r.data,
    ctx.mode,
  );
}

export async function cmdConfig(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  await runTrojanGet(amCtx(flags), "config");
}

// ── Semantic UI surface (spec: docs/specs/2026-07-10-semantic-ui-testing.md) ──

type SurfaceNode = {
  component: string;
  key?: string | number;
  path: string;
  text?: string;
  elements: {
    name: string;
    tag: string;
    events: string[];
    text?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
  }[];
  children: SurfaceNode[];
};

function renderSurface(node: SurfaceNode, indent = ""): string {
  const keyStr = node.key !== undefined ? ` [key=${node.key}]` : "";
  let out = `${indent}${node.component}${keyStr}\n`;
  for (const el of node.elements) {
    const bits: string[] = [];
    if (el.text) bits.push(`"${el.text}"`);
    if (el.value !== undefined) bits.push(`value=${JSON.stringify(el.value)}`);
    if (el.checked !== undefined) bits.push(el.checked ? "☑" : "☐");
    if (el.disabled) bits.push("disabled");
    out += `${indent}  • ${el.name}  <${el.tag}> [${el.events.join(", ")}]${
      bits.length ? "  " + bits.join("  ") : ""
    }\n`;
  }
  for (const child of node.children) {
    out += renderSurface(child, indent + "  ");
  }
  return out;
}

/** `am surface [clientIdx]` — print the client's semantic UI surface: every
 *  component and its triggerable elements, named as the testUI API names them.
 *  What you see here is exactly what `am trigger` (and tests) can drive. */

/** Exported for tests — the scoping rules are the interesting part. @internal */
export const _scope = (
  data: unknown,
  opts: { component?: string; path?: string; depth?: number },
): SurfaceNode[] => scopeSurface(data, opts);

/** Every component name in a surface — for a "no match" message that helps. */
function componentNames(data: unknown): string[] {
  const out = new Set<string>();
  const visit = (n: SurfaceNode) => {
    if (n?.component) out.add(n.component);
    (n?.children ?? []).forEach(visit);
  };
  (Array.isArray(data) ? data as SurfaceNode[] : []).forEach(visit);
  return [...out].sort();
}

/** Narrow a surface to what was asked for: a named component (every instance),
 *  a path prefix, and/or a depth cap. Client-side so it works identically for a
 *  live client and the headless render. */
function scopeSurface(
  data: unknown,
  opts: { component?: string; path?: string; depth?: number },
): SurfaceNode[] {
  let roots = Array.isArray(data) ? data as SurfaceNode[] : [];
  if (opts.component) {
    const hits: SurfaceNode[] = [];
    const visit = (n: SurfaceNode) => {
      if (n?.component === opts.component) hits.push(n);
      (n?.children ?? []).forEach(visit);
    };
    roots.forEach(visit);
    roots = hits;
  }
  if (opts.path) {
    const hits: SurfaceNode[] = [];
    const visit = (n: SurfaceNode) => {
      if (typeof n?.path === "string" && n.path.startsWith(opts.path!)) {
        hits.push(n);
        return; // the subtree comes with it — don't also add its children
      }
      (n?.children ?? []).forEach(visit);
    };
    roots.forEach(visit);
    roots = hits;
  }
  if (opts.depth !== undefined) {
    const prune = (n: SurfaceNode, left: number): SurfaceNode => ({
      ...n,
      children: left <= 0
        ? []
        : (n.children ?? []).map((c) => prune(c, left - 1)),
    });
    roots = roots.map((r) => prune(r, opts.depth!));
  }
  return roots;
}

export async function cmdSurface(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  // `am surface server` renders headlessly ON the server (no client needed).
  const explicit = args.find((a) => !a.startsWith("--")) ?? flags.client;
  // "server", a client index, or nothing. Anything else is a typo, and
  // `Number("mian")` is NaN — which used to be sent as the path segment
  // `surface/NaN` and come back as a confusing server-side miss.
  let target: string | number = "server";
  if (explicit !== "server") {
    const idx = explicit === undefined
      ? { ok: true as const, value: 0 }
      : parseNumArg(String(explicit), "client index", {
        min: 0,
        integer: true,
      });
    if (!idx.ok) {
      outError(`${idx.error} — pass a client index or "server"`, mode);
      Deno.exit(1);
    }
    target = idx.value;
  }
  // `--full` lifts the text cap: element/component text is capped so a surface
  // stays scannable, and a cut is now marked with "…" — but a generated command
  // line has to be readable in full.
  const q = args.includes("--full") ? "?full=1" : "";
  // Scope the tree client-side: one page in a real app serialised to a 32 KB
  // single-line blob, and reading one component out of it meant piping into
  // Python — the same "am made me write a script" shape as the --json one
  //. Applied to the reply, so it works for a live
  // client and the headless render alike.
  const wantComponent = args.find((a) => a.startsWith("--component="))?.slice(
    12,
  );
  const wantPath = args.find((a) => a.startsWith("--path="))?.slice(7);
  const depthArg = args.find((a) => a.startsWith("--depth="))?.slice(8);
  const maxDepth = depthArg === undefined ? undefined : Number(depthArg);
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    outError(
      `--depth must be a non-negative integer (got "${depthArg}")`,
      mode,
    );
    Deno.exit(1);
  }
  let result = await trojanGet(port, `surface/${target}${q}`, appId, 10_000);
  let headlessRender = target === "server";
  if (!result.ok && explicit === undefined) {
    // No client connected and none requested → fall back to the headless
    // server-side render. Loud about it.
    const headless = await trojanGet(
      port,
      `surface/server${q}`,
      appId,
      10_000,
    );
    if (headless.ok) {
      if (mode !== "json") {
        console.error(
          "note: no client connected — this is a server-side render",
        );
      }
      result = headless;
      headlessRender = true;
    }
  }
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const scoped = scopeSurface(result.data, {
    component: wantComponent,
    path: wantPath,
    depth: maxDepth,
  });
  if (scoped.length === 0 && (wantComponent || wantPath)) {
    // Loud, and useful: an empty result from a filter is usually a typo, so say
    // what IS there rather than printing nothing.
    outError(
      `no match for ${
        wantComponent ? `--component=${wantComponent}` : `--path=${wantPath}`
      } — components in this surface: ${
        componentNames(result.data).join(", ") || "(none)"
      }`,
      mode,
    );
    Deno.exit(1);
  }
  if (mode === "json") {
    out(scoped, mode);
    return;
  }
  const roots = scoped;
  if (!Array.isArray(roots) || roots.length === 0) {
    out("(no mounted UI surface)", mode);
    return;
  }
  console.log(roots.map((r) => renderSurface(r)).join("\n"));
  // The hint has to be a command that can actually RUN. A headless render has
  // no client behind it and `am trigger` drives a client, so `am trigger 0`
  // here dead-ends the observe -> act -> observe loop one step after this line
  // (it used to print exactly that, because the hint assumed a client).
  console.log(
    headlessRender
      ? `this is a server-side render — am trigger drives a CONNECTED ` +
        `client: open the app (or start it with --client=browser), then ` +
        `am surface 0`
      : `trigger with: am trigger ${target} "<Component…:Element>" <action> [text]`,
  );
}

/** Parse a chord like `"ctrl+shift+Enter"` (or a bare `"ctrl+alt"`) into the
 *  modifier flags plus the key, so one spelling drives keys and pointer
 *  gestures alike. Unknown segments are the KEY — `"Enter"`, `"a"`, `"F2"` —
 *  and a bare modifier list yields no key at all. */
export function parseChord(
  spec: string,
): { mods?: Record<string, boolean>; key: string } {
  const MODS: Record<string, string> = {
    ctrl: "ctrlKey",
    control: "ctrlKey",
    cmd: "metaKey",
    meta: "metaKey",
    super: "metaKey",
    alt: "altKey",
    option: "altKey",
    shift: "shiftKey",
  };
  const parts = spec.split("+").filter(Boolean);
  const mods: Record<string, boolean> = {};
  const keys: string[] = [];
  for (const p of parts) {
    const flag = MODS[p.toLowerCase()];
    if (flag) mods[flag] = true;
    else keys.push(p);
  }
  // The literal `+` key: splitting on "+" swallows it, so `press "+"` (zoom
  // in — a real gesture) and `press "ctrl++"` would silently fall back to the
  // caller's default key. A spec that ENDS in a separator with no key parsed
  // means the key IS "+".
  let key = keys.join("+");
  if (key === "" && spec.endsWith("+") && spec.length > 0) key = "+";
  return {
    mods: Object.keys(mods).length ? mods : undefined,
    key,
  };
}

/** `am trigger <clientIdx> <path> <action> [text]` — faithfully simulate a
 *  user interaction on a live client via the semantic surface (same event
 *  sequences as testUI). Full testUI action set: click, dblclick, type,
 *  setValue, press, hover, focus, blur, select, check, uncheck, clear, scroll,
 *  dragTo.
 *
 *  `type` APPENDS (a user typing into a field that already has a value) and
 *  `setValue` REPLACES — exactly as `testUI`'s `ui.X.type()` / `ui.X.setValue()`
 *  do, because they are two drivers of ONE UI and a word that means different
 *  things on each side is the worst kind of divergence. Driving a form usually
 *  wants `setValue`; before it existed here the only replace was `clear` then
 *  `type`, which a field report reasonably read as `type` being wrong.
 *  `setValue` is composed from those two — it is not a separate wire action. */
export async function cmdTrigger(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const [idxStr, path, action, text] = args;
  const idx = Number(idxStr);
  const actions = new Set([
    "click",
    "dblclick",
    "type",
    "setValue",
    "press",
    "keyDown",
    "keyUp",
    "hover",
    "focus",
    "blur",
    "select",
    "check",
    "uncheck",
    "clear",
    "scroll",
    "dragTo",
  ]);
  if (!Number.isInteger(idx) || !path || !action || !actions.has(action)) {
    outError(
      'usage: am trigger <clientIdx> "<Component…:Element>" <action> [text]\n' +
        "actions: click, dblclick, type <text>, setValue <text>, press, keyDown,\n" +
        "         keyUp, hover, focus, blur, select <value>, check, uncheck,\n" +
        '         clear, scroll "top=200 left=0", dragTo "<target path>"\n' +
        "type APPENDS to the field's current value; setValue REPLACES it\n" +
        "  (same words, same meanings as testUI's ui.X.type / ui.X.setValue)\n" +
        "keyDown/keyUp hold/release a key (games, drag) — pair them around frames\n" +
        'modifiers: press "ctrl+Enter" · click "ctrl" · click "ctrl+shift"\n' +
        "discover paths with: am surface <clientIdx>",
      mode,
    );
    Deno.exit(1);
  }
  // ONE decider for "did this trigger actually happen".
  //
  // A trigger's reply carries its OWN `ok`: `runUITrigger` (src/air/ui-remote.ts)
  // answers a path that is not on the live surface with
  // `{ok:false, error, available:[…]}` — inside an HTTP 200, because the
  // *request* succeeded. `am trigger` used to check only the transport-level
  // `result.ok` on the action itself (while the `clear` half of `setValue`, four
  // lines away, DID check the body's `ok`): two rules for one fact, and the
  // weaker one sat on the path every trigger takes. The documented agent loop
  // — observe → act → observe — then reported the ACT as done when nothing was
  // clicked, and a script chaining on `&&` walked straight past it.
  //
  // The body is still printed either way: `available` is how a caller
  // self-corrects without another round-trip. Only the exit code changes.
  const post = async (body: Record<string, unknown>): Promise<unknown> => {
    const r = await trojanPost(port, `trigger/${idx}`, body, appId);
    if (!r.ok) {
      outError(r.error, mode);
      Deno.exit(1);
    }
    const data = r.data as { ok?: boolean } | null;
    if (data && data.ok === false) {
      out(data, mode);
      Deno.exit(1);
    }
    return r.data;
  };

  // setValue = clear, then type — testUI's exact definition, composed here so
  // the wire action set stays the one both drivers share. The clear's own
  // result is inspected too: on a path miss the element does not exist, and
  // typing into it next would answer with a second, identical miss instead of
  // the first one's `available` list.
  if (action === "setValue") {
    await post({ path, action: "clear" });
  }
  const wire = action === "setValue" ? "type" : action;
  const body: Record<string, unknown> = { path, action: wire };
  if (
    wire === "type" || wire === "select" || wire === "scroll" ||
    wire === "dragTo"
  ) body.text = text ?? "";
  if (wire === "press" || wire === "keyDown" || wire === "keyUp") {
    const chord = parseChord(text ?? "Enter");
    body.key = chord.key || "Enter";
    if (chord.mods) body.mods = chord.mods;
  }
  // Modified pointer gestures — ctrl+click to add, shift+click to extend.
  // testUI has had modifiers on `press` for a while and `am` had none at all,
  // so the two drivers of ONE UI could not express the same interaction; an
  // app whose primary gesture is ctrl+click was undrivable from the CLI.
  if (wire === "click" || wire === "dblclick" || wire === "hover") {
    const chord = parseChord(text ?? "");
    if (chord.mods) body.mods = chord.mods;
  }
  const replied = await post(body);
  // Report the action the caller asked for, not the wire action it decomposed
  // into — a reply saying "type" to a `setValue` request reads like the command
  // did something else.
  const data = action === "setValue" && replied && typeof replied === "object"
    ? { ...replied as Record<string, unknown>, action }
    : replied;
  out(data, mode);
}

/** `am open` — open THIS app in a browser.
 *
 *  `am ui` opens amui, the visual MANAGER; nothing opened the app itself, so
 *  the answer to "where is it running?" was: read `am status`, find the port,
 *  type the URL. Three steps for the most common question there is.
 *
 *  `--print` writes the URL instead of opening it, because the other half of
 *  that question is scripts (`open "$(am open --print)"`, curl, a test). */
export async function cmdOpen(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const url = `http://localhost:${port}`;

  // Refuse to open a URL that answers nothing: a browser tab showing
  // ERR_CONNECTION_REFUSED is a worse answer than a sentence saying the app is
  // not running, and it costs the same to find out.
  const live = await fetch(`${url}/__aio/health`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  }).then((r) => {
    r.body?.cancel();
    return r.ok;
  }).catch(() => false);
  if (!live) {
    outError(
      `nothing is serving on ${url} — start it with \`am start\``,
      mode,
    );
    Deno.exit(1);
  }

  if (flags.print || mode === "json") {
    out(mode === "json" ? { url, appId, port } : url, mode);
    return;
  }
  const opener = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "explorer"
    : "xdg-open";
  const p = await new Deno.Command(opener, {
    args: [url],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => null);
  if (!p || (!p.success && Deno.build.os !== "windows")) {
    // `explorer` returns non-zero even when it worked, which is why it is
    // excluded above rather than reported as a failure.
    out(`open it: ${url}`, mode);
    return;
  }
  out(`✓ opened ${url}`, mode);
}

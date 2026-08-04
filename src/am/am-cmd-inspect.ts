/**
 * @module
 * Inspection commands for am — clients, click, sql, log, errors, metrics, health, etc.
 */

import { join } from "@std/path";
import { appDirs } from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, formatUptime, out, outError } from "./am-output.ts";
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

/** Raw stdout+stderr of the app `am` launched — `~/.<appId>/logs/stdout.log`
 *  since alpha38 (it was `<project>/.aio.log`, which put half of one app's
 *  output in the project and half in the app dir). The old path is still read so
 *  `am log` works against an app that is still running from before the move. */
function stdoutLogPath(flags: GlobalFlags): string {
  const current = join(appDirs(resolveAmAppId(flags.app)).logs, "stdout.log");
  try {
    Deno.statSync(current);
    return current;
  } catch { /* not there — fall back to the pre-alpha38 project file */ }
  return ".aio.log";
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

export async function cmdSql(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const query = args.join(" ");
  if (!query) {
    outError("usage: am sql <query>", mode);
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

  // --client flag: tail logs/client.log instead of the stdout capture
  if (flags.client !== undefined) {
    await _tailClientLog(flags);
    return;
  }

  const LOG_FILE = stdoutLogPath(flags);

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
    if (!follow) {
      outError("no log file found", mode);
      return;
    }
  }

  if (!follow) return;

  // --follow / -f: stream new bytes as they arrive (like tail -f)
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

async function _tailClientLog(flags: GlobalFlags): Promise<void> {
  const n = flags.lines ?? 50;
  const follow = flags.follow ?? false;
  const filter = flags.filter;
  const logPath = "log/client.log";

  try {
    const content = await Deno.readTextFile(logPath);
    let lines = content.split("\n").filter(Boolean);
    if (filter) {
      const lc = filter.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(lc));
    }
    const tail = lines.slice(-n);
    for (const line of tail) console.log(line);

    if (!follow) return;

    // Follow mode — poll for new content
    let offset = (await Deno.stat(logPath)).size;
    const poll = async () => {
      try {
        const stat = await Deno.stat(logPath);
        if (stat.size > offset) {
          const f = await Deno.open(logPath, { read: true });
          try {
            await f.seek(offset, Deno.SeekMode.Start);
            const buf = new Uint8Array(stat.size - offset);
            await f.read(buf);
            const newContent = new TextDecoder().decode(buf);
            const newLines = newContent.split("\n").filter(Boolean);
            for (const line of newLines) {
              if (
                !filter || line.toLowerCase().includes(filter.toLowerCase())
              ) {
                console.log(line);
              }
            }
          } finally {
            f.close();
          }
          offset = stat.size;
        }
      } catch { /* file may not exist yet */ }
    };
    setInterval(poll, 500);
    await new Promise(() => {});
  } catch {
    console.log("(no client log yet)");
    if (follow) {
      // Wait for file to appear, then start tailing
      let offset = 0;
      const poll = async () => {
        try {
          const stat = await Deno.stat(logPath);
          if (stat.size > offset) {
            const f = await Deno.open(logPath, { read: true });
            try {
              await f.seek(offset, Deno.SeekMode.Start);
              const buf = new Uint8Array(stat.size - offset);
              await f.read(buf);
              const text = new TextDecoder().decode(buf);
              const newLines = text.split("\n").filter(Boolean);
              for (const line of newLines) {
                if (
                  !filter || line.toLowerCase().includes(filter!.toLowerCase())
                ) {
                  console.log(line);
                }
              }
            } finally {
              f.close();
            }
            offset = stat.size;
          }
        } catch { /* not yet */ }
      };
      setInterval(poll, 1000);
      await new Promise(() => {});
    }
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
  if (errors.length === 0) {
    out(mode === "pretty" ? "no errors" : { errors: [] }, mode);
  } else {
    out(mode === "pretty" ? errors.join("\n") : { errors }, mode);
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
    await Deno.writeTextFile(file, JSON.stringify(profile, null, 2));
    out(
      mode === "pretty" ? `wrote ${file}` : { ok: true, file },
      mode,
    );
    return;
  }
  out(profile, mode);
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
        console.error("(no client connected — server-side render)");
      }
      result = headless;
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
  console.log(
    `trigger with: am trigger ${
      target === "server" ? 0 : target
    } "<Component…:Element>" <action> [text]`,
  );
}

/** `am trigger <clientIdx> <path> <action> [text]` — faithfully simulate a
 *  user interaction on a live client via the semantic surface (same event
 *  sequences as testUI). Full testUI action set: click, dblclick, type,
 *  press, hover, focus, blur, select, check, uncheck, clear, scroll, dragTo. */
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
        "actions: click, dblclick, type, press, keyDown, keyUp, hover, focus,\n" +
        "         blur, select <value>, check, uncheck, clear,\n" +
        '         scroll "top=200 left=0", dragTo "<target path>"\n' +
        "keyDown/keyUp hold/release a key (games, drag) — pair them around frames\n" +
        "discover paths with: am surface <clientIdx>",
      mode,
    );
    Deno.exit(1);
  }
  const body: Record<string, unknown> = { path, action };
  if (
    action === "type" || action === "select" || action === "scroll" ||
    action === "dragTo"
  ) body.text = text ?? "";
  if (action === "press" || action === "keyDown" || action === "keyUp") {
    body.key = text ?? "Enter";
  }
  const result = await trojanPost(port, `trigger/${idx}`, body, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

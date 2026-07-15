/**
 * @module
 * Inspection commands for am — clients, click, sql, log, errors, metrics, health, etc.
 */

import type { GlobalFlags } from "./am-types.ts";
import { detectMode, formatUptime, out, outError } from "./am-output.ts";
import { resolveAmAppId, resolvePort } from "./am-utils.ts";
import {
  FETCH_TIMEOUT,
  httpGet,
  resolveControlPort,
  trojanGet,
  trojanPost,
} from "./am-http.ts";

// ── Constants ───────────────────────────────────────────────

const LOG_FILE = ".aio.log";

// ── Client commands ─────────────────────────────────────────

export async function cmdClients(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "clients", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
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

export async function cmdClick(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const clientIdx = args[0];
  const componentName = args[1];
  const targetArg = args[2]; // index (e.g. "0") or prop:value (e.g. 'title:Settings')

  if (!clientIdx || !componentName) {
    outError(
      "usage: am click <clientIndex> <Component> [index | prop:value]",
      mode,
    );
    Deno.exit(1);
  }

  // Build target string: "ComponentName:index" or "ComponentName:prop:value"
  let target = componentName;
  if (targetArg !== undefined) {
    target += ":" + targetArg;
  }

  const result = await trojanGet(
    port,
    `click/${clientIdx}/${encodeURIComponent(target)}`,
    appId,
    10_000,
  );
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

/** `am dom <clientIdx> [--all]` — raw semantic DOM snapshot of a live client
 *  (low-level fallback; prefer `am surface` which names elements the way
 *  tests address them). */
export async function cmdDom(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const idx = Number(args[0] ?? flags.client ?? 0);
  if (!Number.isInteger(idx) || idx < 0) {
    outError("usage: am dom <clientIdx> [--all]", mode);
    Deno.exit(1);
  }
  // --all is consumed by parseGlobalFlags — read it from flags, not args
  const all = flags.all === true;
  const result = await trojanGet(
    port,
    `dom/${idx}${all ? "?all=true" : ""}`,
    appId,
    10_000,
  );
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

export async function cmdInteract(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const clientIdx = flags.client ?? 0;

  const action = args[0];
  const selector = args[1];
  const value = args[2];

  const validActions = new Set([
    "click",
    "type",
    "select",
    "focus",
    "blur",
    "scroll",
    "hover",
  ]);
  if (!action || !selector || (action && !validActions.has(action))) {
    outError(
      'usage: am interact <action> "<selector>" [value] [--client=N]\n' +
        "actions: click, type, select, focus, blur, scroll, hover",
      mode,
    );
    Deno.exit(1);
  }

  const cmd = {
    action,
    selector,
    ...(value !== undefined ? { value } : {}),
  };

  const result = await trojanPost(port, `interact/${clientIdx}`, cmd, appId);
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
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "schedules", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

export async function cmdLog(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);

  // --client flag: tail log/client.log instead of .aio.log
  if (flags.client !== undefined) {
    await _tailClientLog(flags);
    return;
  }

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
  const timeoutMs = tArg ? Number(tArg.slice(10)) : 1500;
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
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "config", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
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
export async function cmdSurface(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const idx = Number(args[0] ?? flags.client ?? 0);
  const result = await trojanGet(port, `surface/${idx}`, appId, 10_000);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  if (mode === "json") {
    out(result.data, mode);
    return;
  }
  const roots = result.data as SurfaceNode[];
  if (!Array.isArray(roots) || roots.length === 0) {
    out("(no mounted UI surface)", mode);
    return;
  }
  console.log(roots.map((r) => renderSurface(r)).join("\n"));
  console.log(
    `trigger with: am trigger ${idx} "<Component…:Element>" <action> [text]`,
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
        "actions: click, dblclick, type, press, hover, focus, blur,\n" +
        "         select <value>, check, uncheck, clear,\n" +
        '         scroll "top=200 left=0", dragTo "<target path>"\n' +
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
  if (action === "press") body.key = text ?? "Enter";
  const result = await trojanPost(port, `trigger/${idx}`, body, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

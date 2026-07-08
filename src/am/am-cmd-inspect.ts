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

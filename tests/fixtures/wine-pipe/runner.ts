// Wine rig — the in-container orchestrator. Runs under the LINUX deno in the
// image; everything it spawns runs under Wine:
//
//   wine deno.exe run -A --unstable-ffi host.ts          the framework's pipe host
//   wine node.exe client.js <pipe> <httpPipe>            libuv client (Electron's path)
//   wine deno.exe run -A --unstable-ffi client-deno.ts   connectLocal client (am's path)
//
// Prints per-test lines and ONE summary line `WINE PIPE: N passed, M failed`,
// then every failure with the error the implementation raised (Win32 call +
// GetLastError code, when it is one). Exit code = failures.
//
// Env: WIN_DIR (deno.exe/node.exe, default /home/aio/win), FIXTURES (this
// directory as the container sees it), WINEPREFIX (writable).

const FIX = Deno.env.get("FIXTURES") ??
  new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const WIN = Deno.env.get("WIN_DIR") ?? "/home/aio/win";
const HOME = Deno.env.get("HOME") ?? "/home/aio";

type T = { name: string; ok: boolean; ms: number; error?: string };
const results: T[] = [];
const fail = (name: string, error: string) =>
  results.push({ name, ok: false, ms: 0, error });

const env = {
  WINEDEBUG: "-all",
  DENO_NO_UPDATE_CHECK: "1",
  DENO_NO_PROMPT: "1",
  NO_COLOR: "1",
  // A Windows path for the Windows deno: Z: is Wine's view of /.
  DENO_DIR: `Z:${HOME.replaceAll("/", "\\")}\\deno-win-cache`,
};

async function sh(
  cmd: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const p = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd: FIX,
    env: { ...env, ...extraEnv },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const o = await p.output();
  clearTimeout(t);
  return {
    code: o.code,
    out: new TextDecoder().decode(o.stdout),
    err: new TextDecoder().decode(o.stderr),
  };
}

async function parseResult(
  who: string,
  out: string,
  err: string,
  code: number,
  file?: string,
) {
  if (file) out = await Deno.readTextFile(file).catch(() => "") + "\n" + out;
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) {
    fail(
      `${who}: produced no RESULT (exit ${code})`,
      (err + "\n" + out).trim().split("\n").slice(-25).join("\n"),
    );
    return;
  }
  const r = JSON.parse(line.slice(7)) as { tests: T[]; fatal?: string };
  results.push(...r.tests);
  if (r.fatal) fail(`${who}: fatal`, r.fatal);
}

// ── wine prefix ──────────────────────────────────────────────────────────
console.log("▸ preparing the wine prefix");
await sh(["wineboot", "-i"], 120_000);
const wv = await sh(["wine", "--version"], 30_000);
console.log(`  ${wv.out.trim()}`);

// ── sanity: the two Windows runtimes start at all under Wine ─────────────
for (
  const [name, cmd] of [
    ["deno.exe boots under wine", ["wine", `${WIN}/deno.exe`, "--version"]],
    ["node.exe boots under wine", ["wine", `${WIN}/node.exe`, "--version"]],
  ] as const
) {
  const t0 = Date.now();
  const r = await sh([...cmd], 120_000);
  const ok = r.code === 0 && r.out.trim().length > 0;
  results.push({
    name,
    ok,
    ms: Date.now() - t0,
    error: ok ? undefined : (r.err || r.out).trim().slice(-400),
  });
  console.log(`  ${ok ? "✓" : "✗"} ${name}: ${r.out.trim().split("\n")[0]}`);
  if (!ok) {
    console.log(
      r.err.trim().split("\n").slice(-10).map((l) => "    " + l).join("\n"),
    );
  }
}

// ── host ─────────────────────────────────────────────────────────────────
console.log("▸ starting the pipe host (deno.exe under wine)");
const host = new Deno.Command("wine", {
  args: [`${WIN}/deno.exe`, "run", "-A", "--unstable-ffi", "host.ts"],
  cwd: FIX,
  env,
  stdout: "piped",
  stderr: "piped",
}).spawn();
let hostErr = "";
(async () => {
  for await (const c of host.stderr) hostErr += new TextDecoder().decode(c);
})();

let ready: [string, string] | null = null;
{
  const reader = host.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 120_000;
  const t0 = Date.now();
  while (Date.now() < deadline && !ready) {
    const r = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((res) =>
        setTimeout(
          () => res({ done: true, value: undefined }),
          Math.max(0, deadline - Date.now()),
        )
      ),
    ]);
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    const m = buf.match(/^READY (\S+) (\S+)$/m);
    if (m) ready = [m[1]!, m[2]!];
  }
  if (ready) {
    results.push({
      name: "host: listenLocal ×2 + serveHttpOverLocal up (READY)",
      ok: true,
      ms: Date.now() - t0,
    });
    console.log(`  ✓ READY ${ready[0]} ${ready[1]}`);
    // Keep draining so the host never blocks on a full stdout pipe.
    (async () => {
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
        }
      } catch { /* closed */ }
    })();
  } else {
    await new Promise((r) => setTimeout(r, 500));
    fail(
      "host: listenLocal ×2 + serveHttpOverLocal up (READY)",
      (hostErr + "\n" + buf).trim().slice(-1500) || "no output",
    );
    console.log("  ✗ host never printed READY");
  }
}

if (ready) {
  const [pipe, httpPipe] = ready;
  console.log("▸ node.exe client (libuv — Electron main's path)");
  const nodeResult = `${HOME}/wine-node-result.txt`;
  await Deno.remove(nodeResult).catch(() => {});
  const n = await sh(
    ["wine", `${WIN}/node.exe`, "client.js", pipe, httpPipe],
    400_000,
    { RESULT_FILE: `Z:${nodeResult.replaceAll("/", "\\")}` },
  );
  await parseResult("node client", n.out, n.err, n.code, nodeResult);

  console.log("▸ deno.exe client (connectLocal — am's path)");
  const d = await sh([
    "wine",
    `${WIN}/deno.exe`,
    "run",
    "-A",
    "--unstable-ffi",
    "client-deno.ts",
    pipe,
  ], 300_000);
  await parseResult("deno client", d.out, d.err, d.code);
}

try {
  host.kill("SIGKILL");
} catch { /* gone */ }
await host.status.catch(() => {});
if (hostErr.trim()) {
  console.log("── host stderr ──");
  console.log(hostErr.trim().split("\n").slice(-30).join("\n"));
}

// ── summary ──────────────────────────────────────────────────────────────
console.log("");
for (const t of results) {
  console.log(`${t.ok ? "✓" : "✗"} ${t.name}${t.ms ? ` (${t.ms} ms)` : ""}`);
}
const failed = results.filter((t) => !t.ok);
console.log(
  `\nWINE PIPE: ${
    results.length - failed.length
  } passed, ${failed.length} failed`,
);
for (const f of failed) {
  console.log(
    `  ✗ ${f.name}\n      ${(f.error ?? "").split("\n").join("\n      ")}`,
  );
}
Deno.exit(failed.length);

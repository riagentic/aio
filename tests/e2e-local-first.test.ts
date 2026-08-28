// localFirst e2e — the claim is "methods run where the caller is", so the test
// has to MEASURE that, not the config that requests it. A cell with NO `sync:`
// key at all, an app that only says `aio.run({ localFirst: true })`, one real
// chromium tab: the click must travel as a CRDT op (a row in sync_ops), which
// is only possible if the browser ran the method locally and stamped it.
//
// The counter-test is the load-bearing half: the same app WITHOUT localFirst
// must leave the op-log empty. Otherwise this test would pass on a plain
// server round-trip and prove nothing — the exact "documented limitation with
// no test" decay the reporter paid for twice.
import { assert, assertEquals } from "@std/assert";
import { stopChild } from "./stop-child.ts";

const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });
const ROOT = new URL("..", import.meta.url).pathname;

function findBrowser(): string | null {
  if (Deno.env.get("AIO_E2E") === "0") return null;
  for (
    const c of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]
  ) {
    try {
      Deno.statSync(c);
      return c;
    } catch { /* next */ }
  }
  return null;
}
const BROWSER = findBrowser();

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout: ${what}`);
}

/** Boot a one-cell app (no `sync:` anywhere) and click its button in a real
 *  browser. Returns how many CRDT ops reached the server's op-log. */
async function opsAfterOneClick(localFirst: boolean): Promise<number> {
  const dir = await Deno.makeTempDir({ prefix: "aio-lf-e2e-" });
  const appId = `lf-probe-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      appId,
      title: "LocalFirst Probe",
      nodeModulesDir: "auto",
      unstable: ["kv"],
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "aio",
        lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      },
      imports: {
        "aio": `${ROOT}mod.ts`,
        "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
  // Note what is NOT here: `sync: true`. Under localFirst the app-level switch
  // is the only thing that can make this cell run in the browser.
  await Deno.writeTextFile(
    `${dir}/src/cell.ts`,
    `import { cell } from "aio";
export const board = cell("board", {
  state: { notes: [] as string[] },
  methods: {
    add(s, text: string) {
      s.notes.push(text);
    },
  },
});`,
  );
  await Deno.writeTextFile(
    `${dir}/src/App.tsx`,
    `import { board } from "./cell.ts";
export default function App() {
  return (
    <div>
      <button onClick={() => board.add("note-" + board.notes.length)}>
        Add
      </button>
      <span t="count">{String(board.notes.length)}</span>
    </div>
  );
}`,
  );
  await Deno.writeTextFile(
    `${dir}/src/app.ts`,
    `import "./cell.ts";\nimport { aio } from "aio";\n` +
      `await aio.run({ persist: false, localFirst: ${localFirst} });`,
  );

  const port = freePort();
  const base = `http://localhost:${port}`;
  const proc = new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: `${dir}/home` },
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "src/app.ts",
      "--client=server-only",
      `--port=${port}`,
    ],
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let logBuf = "";
  (async () => {
    const dec = new TextDecoder();
    for await (const c of proc.stdout) logBuf += dec.decode(c);
  })();
  (async () => {
    const dec = new TextDecoder();
    for await (const c of proc.stderr) logBuf += dec.decode(c);
  })();
  // If the app dies, say so with its output — a cleanup-time "child process has
  // already terminated" tells you nothing about why.
  let exited = false;
  proc.status.then(() => (exited = true)).catch(() => (exited = true));

  const profile = await Deno.makeTempDir({ prefix: "aio-lf-prof-" });
  let tab: Deno.ChildProcess | null = null;
  try {
    // waitFor swallows per-attempt errors by design, so the app's own output is
    // the only thing that can explain a failure to come up — attach it here.
    try {
      await waitFor("server up", async () => {
        const res = await fetch(`${base}/__aio/health`);
        await res.body?.cancel();
        return res.ok ? true : null;
      }, 120_000);
    } catch (e) {
      throw new Error(
        `${e}\n(exited: ${exited})\n--- app output ---\n${logBuf.slice(-3000)}`,
      );
    }
    if (localFirst) {
      assert(
        logBuf.includes("localFirst: 1 cell(s) run locally"),
        `the switch must SAY what it adopted:\n${logBuf.slice(-800)}`,
      );
    }

    tab = new Deno.Command(BROWSER!, {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        `${base}/`,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    const client = await waitFor("app client", async () => {
      const cs = await (await fetch(`${base}/__aio/trojan/clients`))
        .json() as { index: number; type: string }[];
      const apps = cs.filter((c) => c.type === "browser");
      return apps.length ? apps[0]! : null;
    });
    await waitFor("mounted", async () => {
      const res = await fetch(`${base}/__aio/trojan/surface/${client.index}`);
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      return JSON.stringify(await res.json()).includes("AddButton")
        ? true
        : null;
    });

    const trig = await (await fetch(
      `${base}/__aio/trojan/trigger/${client.index}`,
      {
        method: "POST",
        headers: { "x-aio": "1", "content-type": "application/json" },
        body: JSON.stringify({ path: "App:AddButton", action: "click" }),
      },
    )).json() as { ok: boolean; error?: string };
    assert(trig.ok, `click failed: ${trig.error}`);

    // Convergence is the same either way — the DISCRIMINATOR is the op-log.
    await waitFor("server state has the note", async () => {
      const st = await (await fetch(`${base}/__aio/trojan/state`)).json() as {
        board?: { notes?: string[] };
      };
      return st.board?.notes?.length === 1 ? true : null;
    });

    const opCount = async (): Promise<number> => {
      const rows = await (await fetch(`${base}/__aio/trojan/sql`, {
        method: "POST",
        headers: { "x-aio": "1", "content-type": "application/json" },
        body: JSON.stringify({ query: "SELECT COUNT(*) AS n FROM sync_ops" }),
      })).json() as { n: number }[] | { error?: string };
      return Array.isArray(rows) ? rows[0]?.n ?? 0 : 0;
    };
    if (!localFirst) return await opCount();
    // The op-log write can commit a beat after the broadcast — poll for it.
    let n = 0;
    for (let i = 0; i < 40 && n === 0; i++) {
      n = await opCount();
      if (n === 0) await new Promise((r) => setTimeout(r, 250));
    }
    if (n === 0) {
      // Dev forwards the browser console to the server, so the client's own
      // account of what it did is in here.
      console.error(`--- app + client output ---\n${logBuf.slice(-4000)}`);
    }
    return n;
  } finally {
    try {
      tab?.kill();
    } catch { /* already gone */ }
    await tab?.status.catch(() => {});
    await stopChild(proc, { quiet: true });
    await Deno.remove(profile, { recursive: true }).catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "localFirst e2e: a cell with no sync: key runs in the browser and ships an op",
  ignore: BROWSER === null,
  async fn() {
    assertEquals(
      await opsAfterOneClick(true),
      1,
      "the click must travel as a CRDT op — that is what 'runs locally' MEANS",
    );
  },
});

Deno.test({
  name: "localFirst e2e: without the switch, the same app ships no ops at all",
  ignore: BROWSER === null,
  async fn() {
    assertEquals(
      await opsAfterOneClick(false),
      0,
      "off, the click is a plain server dispatch — so the test above measures " +
        "localFirst and not merely 'the app works'",
    );
  },
});

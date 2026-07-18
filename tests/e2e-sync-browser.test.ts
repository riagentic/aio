// Offline/CRDT client wiring e2e — `sync: true` is REAL end-to-end now:
// a browser tab's method call becomes an HLC op (engine), the server
// persists it to the op-log AND applies it through normal dispatch (state
// converges), acks the sender, and relays to peers. Two real chromium tabs
// + the server must all agree.
import { assert, assertEquals } from "@std/assert";

// Coverage profiles from spawned deno processes go to a throwaway temp dir.
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

Deno.test({
  name: "sync e2e: browser op → server state converges + peer tab receives it",
  ignore: BROWSER === null,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-sync-e2e-" });
    await Deno.mkdir(`${dir}/src`);
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "Sync Probe",
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
    await Deno.writeTextFile(
      `${dir}/src/cell.ts`,
      `import { cell } from "aio";
export const board = cell("board", {
  state: { notes: [] as string[] },
  sync: true,
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
      `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run({ persist: false });`,
    );

    const port = freePort();
    const base = `http://localhost:${port}`;
    const proc = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir },
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
      stderr: "null",
    }).spawn();
    let logBuf = "";
    (async () => {
      const dec = new TextDecoder();
      for await (const c of proc.stdout) logBuf += dec.decode(c);
    })();

    const profiles: string[] = [];
    const tabs: Deno.ChildProcess[] = [];
    const openTab = async () => {
      const profile = await Deno.makeTempDir({ prefix: "aio-sync-prof-" });
      profiles.push(profile);
      tabs.push(
        new Deno.Command(BROWSER!, {
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
        }).spawn(),
      );
    };

    try {
      // cold deno child compile under full-suite CPU load can exceed 30s
      await waitFor("server up", async () => {
        const res = await fetch(`${base}/__aio/health`);
        await res.body?.cancel();
        return res.ok ? true : null;
      }, 120_000);
      // the sync op-log must be provisioned even with no db: config
      assert(
        logBuf.includes("CRDT tables") || logBuf.includes("sqlite"),
        `expected the sync op-log to boot:\n${logBuf.slice(-800)}`,
      );

      await openTab();
      await openTab();

      const appClients = await waitFor("two app clients", async () => {
        const cs = await (await fetch(`${base}/__aio/trojan/clients`))
          .json() as { index: number; type: string }[];
        const apps = cs.filter((c) => c.type === "browser");
        return apps.length >= 2 ? apps : null;
      });
      const [a, b] = appClients;

      // wait for both tabs to mount
      for (const c of [a!, b!]) {
        await waitFor(`surface of client ${c.index}`, async () => {
          const res = await fetch(`${base}/__aio/trojan/surface/${c.index}`);
          if (!res.ok) {
            await res.body?.cancel();
            return null;
          }
          const s = JSON.stringify(await res.json());
          return s.includes("AddButton") ? true : null;
        });
      }

      // Tab A clicks Add — the click goes through the SYNC ENGINE as an op.
      const trig =
        await (await fetch(`${base}/__aio/trojan/trigger/${a!.index}`, {
          method: "POST",
          headers: { "x-aio": "1", "content-type": "application/json" },
          body: JSON.stringify({ path: "App:AddButton", action: "click" }),
        })).json() as { ok: boolean; error?: string };
      assert(trig.ok, `click failed: ${trig.error}`);

      // 1) SERVER state converges (op applied via normal dispatch)
      await waitFor("server state has the note", async () => {
        const st = await (await fetch(`${base}/__aio/trojan/state`)).json() as {
          board?: { notes?: string[] };
        };
        return st.board?.notes?.length === 1 ? true : null;
      });

      // 2) PEER tab converges (relayed __op applied by its engine)
      await waitFor("peer tab shows count 1", async () => {
        const res = await fetch(`${base}/__aio/trojan/surface/${b!.index}`);
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        const surf = JSON.stringify(await res.json());
        return surf.includes('"count"') && surf.includes('"text":"1"')
          ? true
          : null;
      });

      // 3) SENDER tab shows its own optimistic → confirmed value
      const senderSurf = JSON.stringify(
        await (await fetch(`${base}/__aio/trojan/surface/${a!.index}`)).json(),
      );
      assert(senderSurf.includes('"text":"1"'), "sender converged");

      // 4) The DISCRIMINATOR: the click must have traveled as a CRDT op
      // (engine path), not a plain action — the op-log must contain it.
      // Without this, a fallback plain send would green-wash 1–3.
      const rows = await (await fetch(`${base}/__aio/trojan/sql`, {
        method: "POST",
        headers: { "x-aio": "1", "content-type": "application/json" },
        body: JSON.stringify({
          query: "SELECT COUNT(*) AS n FROM sync_ops",
        }),
      })).json() as { n: number }[];
      assertEquals(rows[0]?.n, 1, "exactly one op persisted in the op-log");
    } finally {
      for (const t of tabs) {
        try {
          t.kill();
        } catch { /* exited */ }
        await t.status;
      }
      for (const pr of profiles) {
        await Deno.remove(pr, { recursive: true }).catch(() => {});
      }
      try {
        proc.kill();
      } catch { /* exited */ }
      await proc.status;
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

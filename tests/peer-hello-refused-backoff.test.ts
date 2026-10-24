// A refused identity hello on the local socket reconnects on the normal
// backoff (1 s, 2 s, 4 s …), not every second for ever — the accepted socket
// used to reset the backoff before the verdict — and each distinct refusal
// reason is said once per side (ERROR at the caller, WARN at the callee), not
// once a round.
import { assert, assertEquals } from "@std/assert";
import { _connectCliUDS } from "../src/server/cli-client.ts";
import { resolveSocketPath } from "../src/server/paths.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { unrunnableElectron } from "./unrunnable-electron.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("a refused identity hello backs off and is said once per reason", async () => {
  const dir = await tempDir("aio-peer-hello-backoff-");
  const saved = ["DISPLAY", "WAYLAND_DISPLAY", "ELECTRON_PATH"].map(
    (k) => [k, Deno.env.get(k)] as const,
  );
  Deno.env.delete("DISPLAY");
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.set("ELECTRON_PATH", await unrunnableElectron(dir));
  await Deno.writeTextFile(
    `${dir}/App.tsx`,
    "export default function App() { return <div>Hi</div>; }\n",
  );
  const { aio, cell } = await import("../mod.ts");
  const appId = `peer-hello-backoff-${Deno.pid}`;
  const app = await aio.run({
    cells: [cell(`phb${Deno.pid}`, { state: { n: 0 }, methods: {} })],
    appId,
    appDir: dir,
    baseDir: dir,
    client: "electron",
    libraryMode: true,
    singleton: false,
    persist: false,
    watch: false,
    resolvePeer: (p: { app: string }) => ({ id: p.app, role: "app" }),
  } as Any);
  const said: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if ((lvl === "warn" || lvl === "error") && msg.includes("refused")) {
          said.push(`${lvl}`);
        }
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as Parameters<typeof setLogger>[0],
  );
  let attempts = 0;
  const link = _connectCliUDS<unknown>(resolveSocketPath(appId), {
    proof: () => {
      attempts++;
      return Promise.resolve(`v1 nobody ${Deno.pid} ${"0".repeat(64)}`);
    },
  });
  try {
    // Backoff ±20%: attempts at 0, 0.8–1.2 s, 2.4–3.6 s, then ≥ 5.6 s. A
    // backoff reset by every accepted socket reconnects ~every 1 s: ≥ 4 here.
    await new Promise((r) => setTimeout(r, 3_900));
    assert(attempts >= 2 && attempts <= 3, `${attempts} attempts in 3.9 s`);
    assertEquals(said.sort(), ["error", "warn"], said.join(","));
  } finally {
    link.close();
    setLogger(prev);
    await (app as Any).close();
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(dir);
  }
});

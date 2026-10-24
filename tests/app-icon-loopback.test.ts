// appIcon() across a real socket — a method on the SERVER emits it, a real
// WebSocket client (`connectCli`) receives the "icon" frame and says what it
// asked for; with nobody connected the server says so.
import { assert } from "@std/assert";
import { aio, appIcon, cell } from "../mod.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { within } from "./within.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name:
    "appIcon: a method's icon change crosses a real WebSocket to a client, and is named when nobody is there",
  sanitizeOps: false, // aio-ok: a live server + a reconnecting client; closed explicitly below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const dir = await tempDir("aio-appicon-loop");
    const appId = `ai-${crypto.randomUUID().slice(0, 8)}`;
    const c = cell(`busy${appId.slice(3)}`, {
      state: { n: 0 },
      methods: {
        work(s) {
          s.n++;
          s.$do(
            appIcon({ tray: ["/a.png", "/b.png"], tooltip: `${s.n} running` }),
          );
        },
      },
    });
    const lines: string[] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn };
    const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    console.log = console.info = console.warn = push;
    const port = freePort();
    const app = await aio.run({
      cells: [c],
      appId,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port,
      appDir: dir,
      baseDir: dir,
      persistDebounceMs: 10,
    });
    let cli: ReturnType<typeof connectCli> | null = null;
    try {
      await c.work();
      await sleep(50);
      assert(
        lines.some((l) => /appIcon: no UI client is connected/.test(l)),
        lines.join("\n"),
      );
      cli = connectCli(`ws://127.0.0.1:${port}/ws`);
      if ((await within(cli.ready, 5000, "T" as const)) === "T") {
        throw new Error("cli never became ready");
      }
      await c.work();
      const want = /appIcon: tray animated · tooltip "2 running"/;
      for (let i = 0; i < 100 && !lines.some((l) => want.test(l)); i++) {
        await sleep(20);
      }
      assert(lines.some((l) => want.test(l)), lines.slice(-12).join("\n"));
    } finally {
      cli?.close();
      await app.close();
      Object.assign(console, orig);
      await dropTempDir(dir);
    }
  },
});

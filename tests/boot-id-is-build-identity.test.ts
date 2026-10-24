// The `boot` frame's id decides whether an open page reloads after the server
// comes back. It was random per boot, so in prod every restart of an
// UNCHANGED build reloaded every tab and lost its drafts and form input. A
// built app's id is now its build's identity (the served bundle's hash): the
// same build restarted keeps the id, a rebuild changes it. Dev (a source run)
// keeps a fresh id per boot — it cannot know cheaply what the page's code is.
import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { dec } from "../src/protocol/envelope.ts";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function bootIdOf(dir: string, prod: boolean): Promise<string> {
  const port = freePort();
  const server = createServer({
    port,
    title: "BootId",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod,
    distDir: join(dir, "dist"),
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    return await new Promise<string>((res, rej) => {
      ws.onerror = () => rej(new Error("ws error"));
      ws.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f?.t === "boot") res((f.d as { id: string }).id);
      };
    });
  } finally {
    ws.close();
    await server.shutdown();
  }
}

Deno.test("boot id: a built app keeps its id across restarts of one build; a rebuild changes it", async () => {
  const dir = await tempDir("aio-bootid-");
  try {
    await Deno.mkdir(join(dir, "dist"));
    await Deno.writeTextFile(join(dir, "dist", "app.js"), "export const v=1;");
    const a = await bootIdOf(dir, true);
    assertEquals(
      await bootIdOf(dir, true),
      a,
      "a restart of the same build must not reload pages",
    );
    await Deno.writeTextFile(join(dir, "dist", "app.js"), "export const v=2;");
    assertNotEquals(await bootIdOf(dir, true), a, "a rebuild must reload");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("boot id: a source run (dev) gets a fresh id per boot", async () => {
  const dir = await tempDir("aio-bootid-dev-");
  try {
    const first = await bootIdOf(dir, false);
    const second = await bootIdOf(dir, false);
    assertNotEquals(first, second, "every dev restart must reload");
  } finally {
    await dropTempDir(dir);
  }
});

// A `--prod` app with no bundle (cli / server-only) serves no pages: nothing
// to reload, so no warning. A bundle that exists but cannot be read is loud.
Deno.test("boot id: no bundle → silent; an unreadable bundle → one warning", async () => {
  const { log } = await import("../src/diagnostics/logger-api.ts");
  const warned: string[] = [];
  const orig = log.warn;
  log.warn =
    ((...a: unknown[]) =>
      void warned.push(a.map(String).join(" "))) as typeof log.warn;
  const dir = await tempDir("aio-bootid-nobundle-");
  try {
    await bootIdOf(dir, true);
    assertEquals(warned.filter((w) => w.includes("boot id")), []);
    await Deno.mkdir(join(dir, "dist", "app.js"), { recursive: true });
    await bootIdOf(dir, true);
    assertEquals(warned.filter((w) => w.includes("boot id")).length, 1);
  } finally {
    log.warn = orig;
    await dropTempDir(dir);
  }
});

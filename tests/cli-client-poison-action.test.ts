// The CLI client's action door had the same two halves the browser's did, and
// only one of them was guarded.
//
//  • `_trySend` encoded only when CONNECTED. A value JSON cannot carry (a
//    BigInt, a cycle) therefore threw at the call site when the socket was up
//    and was accepted into the offline queue in silence when it was not — the
//    same action, two answers.
//  • The queued one was a poison pill: the reconnect drain took the whole
//    queue, threw on it, and lost every action behind it — with their callers
//    left pending on an ack that could never come.
//
// Both are fixed at one door (`state/action-encode.ts`): the frame is built
// before the branch, a refusal names the action, and the drain tells a frame
// that cannot be BUILT (drop it alone, reject its caller) from a transport
// that refuses the WRITE (put the rest back, in order).
import { assert, assertEquals } from "@std/assert";
import { createServer } from "../src/server/server.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const PORT = freePort();

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("cli client: a poison action is refused at the call and never poisons the queue", async () => {
  const seen: string[] = [];
  const dir = await tempDir("aio-cli-poison-");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: PORT,
    title: "CLI poison",
    getUIState: () => ({ n: 0 }),
    dispatch: (a: unknown) => void seen.push((a as { type: string }).type),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));

  const cli = connectCli<{ n: number }>(`http://127.0.0.1:${PORT}`);
  try {
    // Queued: the client has not connected yet on this tick.
    cli.send({ type: "c:before" });
    let refused: unknown;
    try {
      cli.send({ type: "c:poison", payload: { args: [{ n: 7n }] } });
    } catch (e) {
      refused = e;
    }
    assert(refused instanceof Error, "the caller must hear the refusal");
    assert(
      /c:poison/.test(refused.message) &&
        /BigInt|circular/i.test(refused.message),
      `the refusal must name the action and the reason: ${refused.message}`,
    );
    cli.send({ type: "c:after" });

    await waitFor(() => seen.includes("c:after"));
    assertEquals(
      seen.filter((t) => t.startsWith("c:")),
      ["c:before", "c:after"],
      "nothing was lost behind the action that could not be built",
    );
  } finally {
    cli.close();
    await server.shutdown();
    await dropTempDir(dir);
  }
});

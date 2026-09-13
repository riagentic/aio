// `close()` is the one call a CLI client has for "I am done": every timer the
// client owns must be gone when it returns, in every state it can be closed in.
//
// MEASURED before the fix: a client closed before its first connection kept
// the `readyTimeoutMs` deadline armed. It fired after close() had returned and
// rejected `ready` with "Reconnection continues in the background; call close()
// to stop it" — advice for a client that was already closed — and until then
// the resource sanitizer (`deno task test:core`) reported a leaked timer. An
// `await app.ready` made after close() never settled without the option.
//
// These tests run with the op/resource sanitizers ON (Deno's default for
// `deno test`, forced again by test:core): a surviving timer fails the test
// by itself, so no assertion here has to guess at a timer's existence.
import { assert, assertRejects } from "@std/assert";
import { connectCli, connectCliUDS } from "../src/server/cli-client.ts";

Deno.test({
  name:
    "connectCli: close() before the first connection clears the ready deadline and settles ready",
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    // Port 1 is never an aio server: the client sits in its reconnect loop.
    const app = connectCli("ws://127.0.0.1:1/ws", { readyTimeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    app.close();
    await assertRejects(() => app.ready, Error, "closed");
  },
});

Deno.test({
  name:
    "connectCliUDS: close() before the first connection clears the ready deadline and settles ready",
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    const app = connectCliUDS("/nonexistent/aio-close-clears-timers.sock", {
      readyTimeoutMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 50));
    app.close();
    await assertRejects(() => app.ready, Error, "closed");
  },
});

Deno.test({
  name:
    "connectCli: close() before the first connection settles ready without a deadline too",
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    const app = connectCli("ws://127.0.0.1:1/ws");
    app.close();
    await assertRejects(() => app.ready, Error, "closed");
  },
});

// The leak on its own, without awaiting `ready`: the sanitizer is the assertion.
Deno.test({
  name: "connectCli: a client closed while reconnecting holds no timer",
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    const app = connectCli("ws://127.0.0.1:1/ws", { readyTimeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    app.close();
    // The sanitizer checks no timer survives; this checks `ready` settles.
    await assertRejects(() => app.ready, Error, "closed before the first");
    await new Promise((r) => setTimeout(r, 50));
  },
});

Deno.test({
  name: "connectCliUDS: a client closed while reconnecting holds no timer",
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    const app = connectCliUDS("/nonexistent/aio-close-clears-timers.sock", {
      readyTimeoutMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 50));
    app.close();
    // The sanitizer checks no timer survives; this checks `ready` settles.
    await assertRejects(() => app.ready, Error, "closed before the first");
    await new Promise((r) => setTimeout(r, 50));
  },
});

// close() while the UDS dial is still in flight: the dial resolves AFTER close
// returned. It used to adopt that connection anyway — a live socket plus a
// read loop on a client that had been closed, open until the server hung up.
Deno.test({
  name:
    "connectCliUDS: close() during the dial hangs up the connection it lands",
  ignore: Deno.build.os === "windows",
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-uds-close-" });
    const path = `${dir}/s.sock`;
    const listener = Deno.listen({ transport: "unix", path });
    try {
      const app = connectCliUDS(path);
      app.close(); // the dial started synchronously and has not landed yet
      const server = await listener.accept();
      try {
        // The client end must hang up: a read hits EOF. Bounded, so a client
        // that keeps the socket open fails here rather than hanging the run.
        let guard: ReturnType<typeof setTimeout> | undefined;
        const eof = await Promise.race([
          (async () => {
            const buf = new Uint8Array(4096);
            while ((await server.read(buf)) !== null) { /* drain the hello */ }
            return true;
          })(),
          new Promise<false>((r) => {
            guard = setTimeout(() => r(false), 2_000);
          }),
        ]).finally(() => clearTimeout(guard));
        assert(eof, "a client closed during its dial must not keep the socket");
      } finally {
        server.close();
      }
    } finally {
      listener.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

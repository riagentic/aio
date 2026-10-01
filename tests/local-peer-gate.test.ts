// The local-peer gate over a REAL listener — the production property, proven
// end to end on this machine:
//
//   • a foreign peer (same user, NOT this app's window) is given NO state and
//     cannot run a method — but the `ctl` control plane still answers it, which
//     is how `am` and the packaged-app door test reach a running server;
//   • once armed with the window's pid, the window is served normally.
//
// The pid is the kernel's answer (SO_PEERCRED / LOCAL_PEERPID), so a same-user
// process cannot forge it. Windows uses the pipe's client pid; macOS the same
// unix fd path. See src/server/local-peer.ts and local-listen.ts.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/server/uds.ts";
import { primeLocalPeer } from "../src/server/local-peer.ts";
import { dropTempDir, tempDirSync } from "../src/testing/temp-dir.ts";

// The FFI library is a resource Deno's sanitizer tracks per test: open it here,
// before any case, so no case opens a library it does not close. The live
// server keeps it for the process.
primeLocalPeer();

const dir = tempDirSync("local-peer-");
const sock = `${dir}/peer.sock`;

const handle = createUDSListener(
  sock,
  () => ({ n: 1, secret: "hkept" }),
  () => {},
  () => {},
  undefined,
  null,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  { required: true },
);

/** The fd-bearing backend binds asynchronously (node), so wait for the socket
 *  file rather than racing it. */
async function waitBound(p: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      if (Deno.lstatSync(p).isSocket) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`listener never bound ${p}`);
}

/** Send `frame` (if given) and return the first line received, or null when
 *  the deadline passes with nothing — the "refused" outcome. */
async function exchange(
  p: string,
  frame: string | undefined,
  ms = 1200,
): Promise<string | null> {
  const c = await Deno.connect({ transport: "unix", path: p });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (frame !== undefined) {
      const w = c.writable.getWriter();
      await w.write(new TextEncoder().encode(frame + "\n"));
    }
    const reader = c.readable.getReader();
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((res) => {
        timer = setTimeout(() => res(null), ms);
      }),
    ]);
    if (r === null || r.done || !r.value) return null;
    return new TextDecoder().decode(r.value);
  } finally {
    // The deadline must not outlive the test (Deno's sanitizer counts a timer
    // that fires in a later case against it).
    if (timer !== undefined) clearTimeout(timer);
    try {
      c.close();
    } catch { /* already closed by the server */ }
  }
}

Deno.test("local-peer gate: a foreign peer is given NO state, but `ctl` is answered", async () => {
  await waitBound(sock);
  const reply = await exchange(
    sock,
    JSON.stringify({
      v: 2,
      t: "ctl",
      d: { id: "1", path: "/__aio/health", method: "GET" },
    }),
  );
  assert(reply !== null, "the control plane did not answer a foreign peer");
  assertStringIncludes(reply, '"ctlr"');
  assertEquals(reply.includes('"t":"state"'), false);
});

Deno.test("local-peer gate: a foreign peer's subscription is dropped", async () => {
  await waitBound(sock);
  assertEquals(
    await exchange(
      sock,
      JSON.stringify({ v: 2, t: "subs", d: { subs: ["*"] } }),
    ),
    null,
  );
});

Deno.test("local-peer gate: once armed with this window's pid, it is served", async () => {
  handle.armPeerPid?.(Deno.pid); // this process stands in for the window
  const line = await exchange(sock, undefined);
  assert(line !== null, "the armed window received nothing");
  assertStringIncludes(line, '"t":"proto"');
});

Deno.test("local-peer gate: a different same-user process gets no state", async () => {
  handle.armPeerPid?.(Deno.pid); // armed to US — the child is a stranger
  const child = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const c = await Deno.connect({ transport: "unix", path: ${
        JSON.stringify(sock)
      } });
       const w = c.writable.getWriter();
       await w.write(new TextEncoder().encode(JSON.stringify({ v: 2, t: "subs", d: { subs: ["*"] } }) + "\\n"));
       const r = c.readable.getReader();
       const got = await Promise.race([r.read(), new Promise((res) => setTimeout(() => res(null), 1000))]);
       console.log(got === null || got.done || !got.value ? "QUIET" : "FRAME");
       try { c.close(); } catch {}`,
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(new TextDecoder().decode(child.stdout).trim(), "QUIET");
});

Deno.test("local-peer gate: shutdown closes the door and removes the socket", async () => {
  handle.shutdown();
  await dropTempDir(dir);
  // A closed listener has no door left to open.
  let threw = false;
  try {
    await Deno.connect({ transport: "unix", path: sock });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

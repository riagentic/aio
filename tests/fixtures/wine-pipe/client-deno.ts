// Wine rig — the Deno CLIENT, run as `wine deno.exe run -A --unstable-ffi client-deno.ts <pipe>`.
//
// This is the `am` / cli-client / single-instance-lock path: `connectLocal`
// from the framework's own seam, so the same win-pipe.ts client code that
// `am state` uses is what gets exercised. Prints `RESULT {"tests":[…]}`.
import { connectLocal } from "../../../src/server/local-listen.ts";

const [pipe] = Deno.args;
const tests: { name: string; ok: boolean; ms: number; error?: string }[] = [];
const enc = new TextEncoder();

async function test(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    tests.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    tests.push({
      name,
      ok: false,
      ms: Date.now() - t0,
      error: String((e as Error).message ?? e),
    });
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms)
    ),
  ]);

function makeLines(n: number, tag: string, bigLine = true): string[] {
  return Array.from(
    { length: n },
    (_, i) =>
      JSON.stringify({
        i,
        tag,
        pad: bigLine && i === n >> 1 ? "x".repeat(1024 * 1024) : "",
      }),
  );
}

async function roundTrip(path: string, lines: string[]): Promise<string[]> {
  const conn = await connectLocal(path);
  const w = conn.writable.getWriter();
  const got: string[] = [];
  try {
    const writer = (async () => {
      for (const l of lines) await w.write(enc.encode(l + "\n"));
    })();
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of conn.readable) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        got.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (got.length >= lines.length) break;
    }
    await writer;
  } finally {
    conn.close();
  }
  return got;
}

function assertEchoes(lines: string[], got: string[]) {
  if (got.length !== lines.length) {
    throw new Error(`got ${got.length}/${lines.length}`);
  }
  for (let i = 0; i < lines.length; i++) {
    if (got[i] !== `{"echo":${lines[i]}}`) {
      throw new Error(
        `line ${i} out of order or corrupted (${got[i].slice(0, 60)}…)`,
      );
    }
  }
}

await test("deno ndjson 1000 lines incl. 1 MB (connectLocal)", async () => {
  const lines = makeLines(1000, "deno");
  assertEchoes(
    lines,
    await withTimeout(roundTrip(pipe, lines), 60_000, "echo"),
  );
});

await test("deno 8 concurrent connectLocal clients", async () => {
  await withTimeout(
    Promise.all(Array.from({ length: 8 }, (_, k) => {
      const lines = makeLines(50, `d${k}`, false);
      return roundTrip(pipe, lines).then((got) => assertEchoes(lines, got));
    })),
    60_000,
    "8 clients",
  );
});

await test("deno negative control: unhosted pipe rejects fast with a named error", async () => {
  const t0 = Date.now();
  const nobody = `\\\\.\\pipe\\aio-nobody-${crypto.randomUUID().slice(0, 8)}`;
  let err: unknown = null;
  try {
    const c = await withTimeout(
      connectLocal(nobody),
      5_000,
      "connectLocal(unhosted)",
    );
    c.close();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error("connected to a pipe nobody hosts");
  const ms = Date.now() - t0;
  const msg = String((err as Error).message ?? err);
  if (ms > 3_000) throw new Error(`took ${ms}ms: ${msg}`);
  // The contract: every Win32 failure names the call, the code and the path.
  if (
    !/Win32 error 2\b|ERROR_FILE_NOT_FOUND/.test(
      msg,
    ) || !msg.includes("aio-nobody")
  ) {
    throw new Error(`error does not name the call/code/path: ${msg}`);
  }
});

console.log(`RESULT ${JSON.stringify({ tests })}`);
Deno.exit(0);

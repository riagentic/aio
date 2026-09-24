// The newline-framed reader every UDS peer uses (src/protocol/line-reader.ts):
// the Electron main process (embedded into the generated main.cjs by its own
// source), the server's per-connection reader and the Deno CLI client.
//
// It replaced `buf += chunk; buf.split("\n")`, which rescans the whole carried
// frame on every chunk — quadratic on a multi-MB state frame. Two things are
// pinned: it splits EXACTLY as the old code did, however the stream is
// chunked, and one big frame costs time linear in its size.
import { assert, assertEquals } from "@std/assert";
import { createLineReader } from "../src/protocol/line-reader.ts";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

/** The old reader, as the oracle. */
function splitOracle(chunks: string[]): { lines: string[]; rest: string } {
  let buf = "";
  const lines: string[] = [];
  for (const c of chunks) {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    lines.push(...parts);
  }
  return { lines, rest: buf };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("line reader: splits exactly like buf.split, under any chunking", () => {
  const seed = fuzzEnvInt(
    "LINE_READER_SEED",
    Math.floor(Math.random() * 2 ** 31),
  );
  const r = rng(seed);
  for (let round = 0; round < 2000; round++) {
    // A stream of frames (some empty — consecutive newlines), cut anywhere.
    let stream = "";
    const frames = Math.floor(r() * 8);
    for (let i = 0; i < frames; i++) {
      stream += "é{x}".repeat(Math.floor(r() * 6)) + "\n";
    }
    if (r() < 0.5) stream += "tail-without-newline";
    const chunks: string[] = [];
    for (let i = 0; i < stream.length;) {
      const n = 1 + Math.floor(r() * 7);
      chunks.push(stream.slice(i, i + n));
      i += n;
    }
    if (r() < 0.2) chunks.splice(Math.floor(r() * (chunks.length + 1)), 0, "");
    const reader = createLineReader();
    const got = chunks.flatMap((c) => reader.push(c));
    const want = splitOracle(chunks);
    assertEquals(got, want.lines, `seed ${seed} round ${round}`);
    assertEquals(
      reader.pending(),
      want.rest.length,
      `seed ${seed} round ${round}`,
    );
  }
});

Deno.test("line reader: reset drops the unfinished frame", () => {
  const reader = createLineReader();
  assertEquals(reader.push('{"n":1}\n{"n":2'), ['{"n":1}']);
  assertEquals(reader.pending(), 6);
  reader.reset();
  assertEquals(reader.pending(), 0);
  assertEquals(reader.push('{"n":3}\n'), ['{"n":3}']);
});

Deno.test("line reader: a 4 MB frame in 1 KB chunks is read in linear time", () => {
  // Coarse on purpose: the linear reader takes tens of ms here; the quadratic
  // one rescans ~2 MB on average for each of 4096 chunks (≈8 GB of work).
  const frame = "x".repeat(4 * 1024 * 1024);
  const chunk = 1024;
  const reader = createLineReader();
  const t0 = performance.now();
  let lines: string[] = [];
  for (let i = 0; i < frame.length; i += chunk) {
    lines = lines.concat(reader.push(frame.slice(i, i + chunk)));
  }
  lines = lines.concat(reader.push("\nnext\n"));
  const ms = performance.now() - t0;
  assertEquals(lines.length, 2);
  assertEquals(lines[0]!.length, frame.length);
  assertEquals(lines[1], "next");
  assert(
    ms < 1000,
    `4 MB in 1 KB chunks took ${ms.toFixed(0)} ms — quadratic?`,
  );
});

Deno.test("line reader: the Electron main process embeds THIS reader, not a copy", () => {
  const script = electronMainScriptUDS("http://127.0.0.1:1", "/tmp/x.sock", {});
  assert(
    script.includes(createLineReader.toString()),
    "main.cjs does not embed createLineReader's own source",
  );
  const onData = script.slice(script.indexOf("sock.on('data'"));
  const body = onData.slice(0, onData.indexOf("sock.on('error'"));
  assert(
    !/\.split\(/.test(body),
    `the socket's data handler splits a carried buffer again:\n${body}`,
  );
});

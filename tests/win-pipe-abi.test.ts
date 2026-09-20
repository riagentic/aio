// The pure half of src/server/win-pipe.ts — struct layouts, string encoding,
// error mapping, bitmask hygiene — proven on every OS. The FFI half runs only
// on windows (and under Wine in CI: tests/wine-pipe-e2e.test.ts).

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  entryOverlapped,
  ERROR_BROKEN_PIPE,
  ERROR_FILE_NOT_FOUND,
  ERROR_INVALID_HANDLE,
  ERROR_IO_PENDING,
  ERROR_MORE_DATA,
  ERROR_OPERATION_ABORTED,
  ERROR_PIPE_BUSY,
  ERROR_PIPE_CONNECTED,
  FILE_FLAG_OVERLAPPED,
  GENERIC_READ,
  GENERIC_WRITE,
  INVALID_HANDLE_VALUE,
  isPeerGoneError,
  OVERLAPPED_ENTRY_SIZE,
  overlappedBytes,
  overlappedEvent,
  PIPE_ACCESS_DUPLEX,
  PIPE_DRAIN_TIMEOUT_MS,
  PIPE_SDDL,
  readU32,
  readU64,
  securityAttributesBytes,
  u32,
  winError,
  wstr,
} from "../src/server/win-pipe.ts";
import { isPipePath, PIPE_PREFIX } from "../src/server/local-listen.ts";

Deno.test("Win32 error codes are the documented values", () => {
  assertEquals(ERROR_FILE_NOT_FOUND, 2);
  assertEquals(ERROR_INVALID_HANDLE, 6);
  assertEquals(ERROR_BROKEN_PIPE, 109);
  assertEquals(ERROR_PIPE_BUSY, 231);
  assertEquals(ERROR_MORE_DATA, 234);
  assertEquals(ERROR_PIPE_CONNECTED, 535);
  assertEquals(ERROR_OPERATION_ABORTED, 995);
  assertEquals(ERROR_IO_PENDING, 997);
  assertEquals(INVALID_HANDLE_VALUE, 0xFFFFFFFFFFFFFFFFn);
});

Deno.test("OVERLAPPED: 32 bytes on x64, hEvent at offset 24, everything else zero", () => {
  const ev = 0x0000_0123_4567_89ABn;
  const o = overlappedBytes(ev);
  assertEquals(o.length, 32);
  for (let i = 0; i < 24; i++) assertEquals(o[i], 0, `byte ${i}`);
  assertEquals(overlappedEvent(o), ev);
  // Little-endian: the low byte first.
  assertEquals(o[24], 0xAB);
  assertEquals(o[31], 0x00);
  // A fresh struct per call — never a shared one.
  assert(overlappedBytes(ev) !== o);
});

Deno.test("SECURITY_ATTRIBUTES: 24 bytes, nLength=24, descriptor at 8, bInheritHandle=0", () => {
  const sa = securityAttributesBytes(0xDEADBEEFn);
  assertEquals(sa.length, 24);
  assertEquals(readU32(sa), 24);
  assertEquals(readU64(sa.subarray(8)), 0xDEADBEEFn);
  assertEquals(readU32(sa.subarray(16)), 0);
});

Deno.test("wstr: UTF-16LE, NUL-terminated, byteLength = 2*(len+1)", () => {
  const w = wstr("\\\\.\\pipe\\aio-x");
  assertEquals(w.length, 2 * ("\\\\.\\pipe\\aio-x".length + 1));
  assertEquals(w[0], 0x5C); // '\'
  assertEquals(w[1], 0);
  assertEquals(w[w.length - 2], 0);
  assertEquals(w[w.length - 1], 0);
  const e = wstr("é");
  assertEquals([e[0], e[1]], [0xE9, 0x00]);
});

Deno.test("u32: a bitmask is never handed to FFI as a negative int32", () => {
  // `GENERIC_READ | GENERIC_WRITE` is -1073741824 in JS — Deno FFI refuses it
  // for a u32 parameter before CreateFileW even runs (found under Wine).
  assert((GENERIC_READ | GENERIC_WRITE) < 0);
  assertEquals(u32(GENERIC_READ | GENERIC_WRITE), 0xC0000000);
  assertEquals(u32(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED), 0x40000003);
  assertEquals(u32(3), 3);
});

Deno.test("winError names the call, the code, its symbol and the path", () => {
  const e = winError("CreateNamedPipeW", ERROR_PIPE_BUSY, "\\\\.\\pipe\\aio-x");
  assertMatch(
    e.message,
    /^CreateNamedPipeW failed on \\\\\.\\pipe\\aio-x — Win32 error 231 ERROR_PIPE_BUSY$/,
  );
  assertEquals((e as Error & { code: number }).code, 231);
  // An unknown code still carries the number.
  assertMatch(winError("X", 4242, "p").message, /Win32 error 4242$/);
});

Deno.test("isPeerGoneError: end-of-stream codes vs real failures", () => {
  for (
    const c of [
      ERROR_BROKEN_PIPE,
      233,
      232,
      38,
      ERROR_OPERATION_ABORTED,
      ERROR_INVALID_HANDLE,
    ]
  ) {
    assert(isPeerGoneError(c), String(c));
  }
  for (
    const c of [
      ERROR_FILE_NOT_FOUND,
      5,
      ERROR_PIPE_BUSY,
      ERROR_IO_PENDING,
      ERROR_MORE_DATA,
    ]
  ) {
    assert(!isPeerGoneError(c), String(c));
  }
});

Deno.test("PIPE_SDDL: protected DACL, owner + LocalSystem only, no Everyone", () => {
  assert(PIPE_SDDL.startsWith("D:P"));
  assert(PIPE_SDDL.includes(";;;OW)"));
  assert(PIPE_SDDL.includes(";;;SY)"));
  assert(!PIPE_SDDL.includes("WD"), "Everyone must not appear");
  assert(!PIPE_SDDL.includes("AN"), "Anonymous must not appear");
});

Deno.test("isPipePath: exactly the \\\\.\\pipe\\ namespace", () => {
  assertEquals(PIPE_PREFIX, "\\\\.\\pipe\\");
  assert(isPipePath("\\\\.\\pipe\\aio-x"));
  assert(!isPipePath("/tmp/aio/x.sock"));
  assert(!isPipePath("C:\\Users\\x\\x.sock"));
  assert(!isPipePath("//./pipe/x"));
});

// ── One parked thread, whatever the connection count (field report §13) ──
//
// Every pending operation used to park its own `nonblocking: true`
// `WaitForSingleObject` on a blocking-pool thread, and every open connection
// ALWAYS has a pending read. The pool is capped (4×cores on Windows, 32 on
// unix), so past the cap every further nonblocking FFI call and every async
// fs op queued behind waits only queued work could release: a permanent
// freeze of the whole app. Measured on Windows 11 — 40 idle clients hung, 40
// never-read responses hung, server threads 11 → 39 — and reproduced in the
// Wine rig, where the host stops answering at 4×cores+16 clients.
//
// The shape that fixes it cannot be unit-tested on Linux, but the RULE can:
// no per-operation blocking wait may exist in this file at all.
Deno.test("win-pipe: no per-operation blocking wait — the completion port is the only one", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/win-pipe.ts", import.meta.url),
  );
  const code = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  assertEquals(
    code.includes("WaitForSingleObject"),
    false,
    "one wait per pending operation is the deadlock — operations complete " +
      "onto the I/O completion port",
  );
  // Every blocking-pool call in the file, named, with why it is bounded.
  const parked = [...code.matchAll(/(\w+):\s*\{[^}]*nonblocking:\s*true/g)]
    .map((m) => m[1]);
  // …and the COUNT, independently of the shape the symbol is written in.
  // The name-matching regex above stops at the first `}`, so a declaration
  // holding a nested object (`parameters: [{ struct: [...] }]`, a struct
  // `result`) hides its `nonblocking: true` from it — a new unbounded parked
  // call could then be added with this gate still green. Verified by adding
  // exactly that symbol: the list below stayed correct, this count did not.
  assertEquals(
    (code.match(/nonblocking:\s*true/g) ?? []).length,
    parked.length,
    "a `nonblocking: true` the name list above cannot see — every parked FFI " +
      "call must be NAMED here, whatever shape its declaration is written in",
  );
  assertEquals(
    parked.sort(),
    // GetQueuedCompletionStatusEx: ONE, for the whole process, only while
    // something is pending. FlushFileBuffers: bounded by PIPE_DRAIN_TIMEOUT_MS,
    // then the connection is closed. WaitNamedPipeW: bounded, 2 s, and only
    // when every pipe instance is mid-connect.
    ["FlushFileBuffers", "GetQueuedCompletionStatusEx", "WaitNamedPipeW"],
    "a new parked FFI call needs a bound — an unbounded one is the freeze",
  );
  // The drain's bound is a number, and the timeout closes the connection.
  assert(Number.isFinite(PIPE_DRAIN_TIMEOUT_MS) && PIPE_DRAIN_TIMEOUT_MS > 0);
  const drain = code.slice(code.indexOf("async drain("));
  assertStringIncludes(
    drain.slice(0, drain.indexOf("async #write")),
    "this.close()",
    "a peer that stops reading must cost a CLOSED connection",
  );
});

Deno.test("OVERLAPPED_ENTRY: lpOverlapped at offset 8 identifies the operation", () => {
  assertEquals(OVERLAPPED_ENTRY_SIZE, 32);
  const entries = new Uint8Array(OVERLAPPED_ENTRY_SIZE * 3);
  const v = new DataView(entries.buffer);
  v.setBigUint64(0 * 32 + 8, 0x1111_2222_3333_4440n, true);
  v.setBigUint64(1 * 32 + 8, 0x0000_0000_dead_beefn, true);
  v.setBigUint64(2 * 32 + 8, 0x7fff_ffff_ffff_fff0n, true);
  assertEquals(entryOverlapped(entries, 0), 0x1111_2222_3333_4440n);
  assertEquals(entryOverlapped(entries, 1), 0xdeadbeefn);
  assertEquals(entryOverlapped(entries, 2), 0x7fff_ffff_ffff_fff0n);
  // A completion key or a byte count must never be mistaken for it.
  v.setBigUint64(1 * 32, 0xffff_ffff_ffff_ffffn, true); // lpCompletionKey
  v.setUint32(1 * 32 + 24, 4096, true); // bytes transferred
  assertEquals(entryOverlapped(entries, 1), 0xdeadbeefn);
});

// An OVERLAPPED whose hEvent has its LOW BIT SET tells the kernel to skip the
// completion port — the operation would then complete into nothing and its
// promise would never settle. Every OVERLAPPED this module starts carries 0.
Deno.test("win-pipe: hEvent is NULL, so the completion goes to the port", () => {
  const o = overlappedBytes(0n);
  assertEquals(overlappedEvent(o), 0n);
  assertEquals(overlappedEvent(o) & 1n, 0n, "a set low bit skips the port");
});

// Measured on real Windows 11 (2026-09-18): `DisconnectNamedPipe` on the
// server end DISCARDS what the client has not read yet, even after the
// FlushFileBuffers drain — Chromium lost the last ~64 KB of a 9 MB app.js and
// the window stayed empty (1.0.4-beta: 3/3 empty, 1.0.5-beta: 4/4 rendered).
// Only a real Windows run can show it, so the source is held to the rule: the
// server end is closed, never disconnected. The binding must not even exist.
Deno.test("win-pipe: a server end is closed, never DisconnectNamedPipe'd", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/win-pipe.ts", import.meta.url),
  );
  const code = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  assertEquals(
    code.includes("DisconnectNamedPipe"),
    false,
    "DisconnectNamedPipe drops unread bytes — the empty-window bug",
  );
});

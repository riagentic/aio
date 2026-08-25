// The pure half of src/server/win-pipe.ts — struct layouts, string encoding,
// error mapping, bitmask hygiene — proven on every OS. The FFI half runs only
// on windows (and under Wine in CI: tests/wine-pipe-e2e.test.ts).

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
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
  overlappedBytes,
  overlappedEvent,
  PIPE_ACCESS_DUPLEX,
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

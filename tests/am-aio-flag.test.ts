/**
 * `--aio <path>` — the space form every other CLI accepts, and the one a
 * shell's own path completion produces — was SILENTLY IGNORED. Only
 * `--aio=<path>` was ever read, so `am link --aio /src/aio` linked against
 * whatever am found on its own and reported success: the developer's explicit
 * choice of framework checkout vanished without a word, which is the exact
 * failure the pin machinery exists to make impossible.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { aioFlagValue, withoutAioFlag } from "../src/am/am-cmd-link.ts";

Deno.test("aioFlagValue: both spellings, and only the flag's own value", () => {
  assertEquals(aioFlagValue(["--aio=/src/aio"]), "/src/aio");
  assertEquals(aioFlagValue(["--aio", "/src/aio"]), "/src/aio");
  assertEquals(aioFlagValue(["--json", "--aio", "/src/aio"]), "/src/aio");
  assertEquals(aioFlagValue(["v1.2.3", "--aio", "/src/aio"]), "/src/aio");
  assertEquals(aioFlagValue([]), undefined);
  assertEquals(aioFlagValue(["--latest"]), undefined);
  // A relative path is a path, not a flag.
  assertEquals(aioFlagValue(["--aio", "../aio"]), "../aio");
  // `--aio-version=` is a DIFFERENT flag (am create) and must not be captured.
  assertEquals(aioFlagValue(["--aio-version=main"]), undefined);
});

Deno.test("aioFlagValue: a value that went missing is REFUSED, never treated as absent", () => {
  assertThrows(() => aioFlagValue(["--aio"]), Error, "--aio needs a path");
  assertThrows(
    () => aioFlagValue(["--aio", "--latest"]),
    Error,
    "--aio needs a path",
  );
});

Deno.test("withoutAioFlag: the PATH is never mistaken for a version ref", () => {
  // `am pin --aio /src/aio` picks its ref with a positional scan. Without
  // this, `/src/aio` would BE the ref — am would go looking for a framework
  // version by that name.
  assertEquals(withoutAioFlag(["--aio", "/src/aio"]), []);
  assertEquals(withoutAioFlag(["--aio=/src/aio", "v1.2.3"]), ["v1.2.3"]);
  assertEquals(
    withoutAioFlag(["v1.2.3", "--aio", "/src/aio", "--latest"]),
    ["v1.2.3", "--latest"],
  );
  assertEquals(withoutAioFlag(["--latest"]), ["--latest"]);
});

// Convention guard: a test that binds a port takes it from `freePort()`.
//
// The suite used to hand-partition port ranges — `const PORT = 9870 + (Deno.pid
// % 60)` in one file, `9830 + (Deno.pid % 200)` in another, plus fixed 198xx
// constants. Two of those ranges overlapped and two files literally shared
// 19840, so a lingering listener made whichever test ran second fail — a real
// flake we chased (auth-client, 2026-07-25). `freePort()` asks the OS for a port
// that is free right now, which removes the bookkeeping AND the flake class.
import { assertEquals } from "@std/assert";

// `\w*(?<![A-Za-z])PORT` = a PORT-named const (PORT, TT_PORT, CDP_PORT) and not
// a word that merely contains it (IMPORT_RE).
const PORT_CONST = /^\s*const\s+\w*(?<![A-Za-z])PORT\w*\s*=\s*(.+?);/gm;
// Allowed right-hand sides: freePort(), another already-checked port const, or
// an env/config lookup. A bare literal or a pid formula is the bug.
const OK = /freePort\(\)|PORT|Deno\.env|env\[|opts\.|config\./;

Deno.test("tests: every port constant comes from freePort()", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir("tests")) {
    if (!entry.isFile || !entry.name.endsWith(".test.ts")) continue;
    if (entry.name === "test-ports-are-free.test.ts") continue;
    const src = await Deno.readTextFile(`tests/${entry.name}`);
    for (const m of src.matchAll(PORT_CONST)) {
      const rhs = m[1]!;
      if (/Deno\.pid/.test(rhs) || !OK.test(rhs)) {
        offenders.push(`${entry.name}: ${m[0]!.trim()}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "a hardcoded or pid-derived test port collides sooner or later — use freePort()",
  );
});

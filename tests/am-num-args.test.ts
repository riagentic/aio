// A CLI flag we cannot read is an ERROR, never a default and never a
// plausible-looking answer.
//
// `Number("2s")` is NaN, and NaN is the quiet kind of wrong. Handed to
// `setTimeout` it becomes 1ms, so `am discover --timeout=2s` — a very ordinary
// typo, since the flag wants milliseconds — swept the LAN for one millisecond,
// found nothing, and printed "no aio apps found on the LAN" complete with a
// confident note about UDP being blocked on some networks. The mistake was in
// the flag; the output sent people to their firewall.
//
// Three call sites had the same shape: `am discover --timeout=`, `am top`'s
// poll interval (which fell back to 1s via `|| 1`, quietly ignoring what was
// asked for), and `am surface`'s client index (`Number("mian")` → the request
// path `surface/NaN`). They now share ONE parser — three hand-written
// validations would drift, and the one that lagged would be the one nobody
// tested.
import { assert, assertEquals } from "@std/assert";
import { parseNumArg } from "../src/am/am-utils.ts";

Deno.test("parseNumArg: refuses everything Number() would turn into NaN", () => {
  for (const bad of ["2s", "abc", "", "  ", "1.2.3", "--timeout", undefined]) {
    const r = parseNumArg(bad, "--timeout (ms)");
    assert(!r.ok, `must refuse ${JSON.stringify(bad)}`);
    assert(
      r.error.includes("--timeout (ms)"),
      `the message names the flag: ${r.error}`,
    );
  }
  // Infinity is a number to `Number()` and a trap to every consumer.
  assert(!parseNumArg("Infinity", "--timeout (ms)").ok);
  assert(!parseNumArg("-Infinity", "--timeout (ms)").ok);
});

Deno.test("parseNumArg: accepts real numbers, in the forms a CLI sees them", () => {
  assertEquals(parseNumArg("1500", "x"), { ok: true, value: 1500 });
  assertEquals(parseNumArg("0", "x"), { ok: true, value: 0 });
  assertEquals(parseNumArg("0.25", "x"), { ok: true, value: 0.25 });
  assertEquals(parseNumArg("-3", "x"), { ok: true, value: -3 });
  assertEquals(parseNumArg(" 12 ", "x"), { ok: true, value: 12 });
});

Deno.test("parseNumArg: bounds and integer-ness are part of the contract", () => {
  const int = parseNumArg("1.5", "client index", { integer: true });
  assert(!int.ok && int.error.includes("whole number"), String(int));

  const low = parseNumArg("-1", "client index", { min: 0 });
  assert(!low.ok && low.error.includes("≥ 0"), String(low));

  const high = parseNumArg("99", "--depth", { max: 10 });
  assert(!high.ok && high.error.includes("≤ 10"), String(high));

  // The boundaries themselves are IN range — an off-by-one here would reject
  // `am surface 0`, the most common invocation there is.
  assert(parseNumArg("0", "client index", { min: 0, integer: true }).ok);
  assert(parseNumArg("10", "--depth", { max: 10 }).ok);
});

Deno.test("parseGlobalFlags: a numeric global flag that does not parse is an ERROR, not a default", async () => {
  // The same NaN class, one layer up: `am logs --lines=1O0` used to silently
  // print the default line count, `--wait=5s` silently used the default wait —
  // the typo was answered with a confident wrong result. `flags.error` is set
  // (first bad flag wins) and `am` exits loud on it before any command runs.
  const { parseGlobalFlags } = await import("../src/am/am-utils.ts");
  for (
    const [argv, flag] of [
      [["--port=80a0", "status"], "--port"],
      [["--lines=1O0", "logs"], "--lines"],
      [["--wait=5s", "start", "app"], "--wait"],
      [["--client=x", "surface"], "--client"],
    ] as const
  ) {
    const { flags } = parseGlobalFlags([...argv]);
    assert(flags.error, `${flag}: expected flags.error`);
    assert(
      flags.error!.includes(flag),
      `${flag}: the error must name the flag — got "${flags.error}"`,
    );
  }
  // …and well-formed values still parse (the strictness cuts garbage, not use).
  const ok = parseGlobalFlags(["--port=9000", "--lines=50", "state"]);
  assertEquals(ok.flags.error, undefined);
  assertEquals(ok.flags.port, 9000);
  assertEquals(ok.flags.lines, 50);
});

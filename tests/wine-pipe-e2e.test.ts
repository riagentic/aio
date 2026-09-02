// The Windows named-pipe transport under Wine — the gate for `deno task test:wine`.
//
// Opt-in (AIO_WINE_E2E=1): it builds a ~5 GB image and runs two Windows
// runtimes under Wine, so it is not in the default suite. The assertion is the
// runner's own summary line — `WINE PIPE: N passed, M failed` with M = 0 — and
// a floor on N, so a runner that quietly ran nothing cannot pass.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";

const GATED = Deno.env.get("AIO_WINE_E2E") === "1";
const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** host READY + deno.exe/node.exe boot + 5 node cases + 3 deno cases. */
const EXPECTED_CASES = 11;

Deno.test({
  name:
    "wine: the named-pipe local transport passes host + libuv client + connectLocal client",
  ignore: !GATED,
  // aio-ok: a real Wine process hosting deno.exe/node.exe; Wine keeps its wineserver alive past the test
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  async fn() {
    const args = ["run", "-A", `${HERE}/scripts/wine-pipe.ts`];
    if (Deno.env.get("AIO_WINE_NO_BUILD") === "1") args.push("--no-build");
    const out = await new Deno.Command(Deno.execPath(), {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    console.log(text);
    const m = text.match(/^WINE PIPE: (\d+) passed, (\d+) failed$/m);
    assert(m, `no summary line in the runner output (exit ${out.code})`);
    assertEquals(
      Number(m[2]),
      0,
      `failures under wine:\n${text.slice(text.indexOf("WINE PIPE:"))}`,
    );
    assert(
      Number(m[1]) >= EXPECTED_CASES,
      `only ${m[1]} cases ran (expected ≥ ${EXPECTED_CASES})`,
    );
    assertEquals(out.code, 0);
    assertMatch(text, /READY \\\\\.\\pipe\\aio-test-/);
    // Write the row. Until this existed nothing recorded that the Windows
    // named-pipe transport had EVER been exercised — the beta gate's Windows
    // claim rested on someone remembering, and this release keeps finding
    // remembered things to be wrong. Last line, so only a full pass records.
    const { recordProof } = await import("../scripts/proof.ts");
    await recordProof("windows", "wine", `${m[1]} cases`);
  },
});

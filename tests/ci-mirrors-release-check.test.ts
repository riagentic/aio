// CI runs what `check:release` runs — checked, not assumed.
//
// alpha56 shipped with `deno lint` red because the local loop and the remote
// loop were two lists maintained by hand. `scripts/release-check.ts` is now
// THE list (FAST + HEAVY); this test reads it and `.github/workflows/ci.yml`
// and requires every gate on it to be a `run:` step somewhere in CI. A gate
// added to the release check without a CI step is red here, on the same push.
import { assertEquals } from "@std/assert";
import { MIN_DENO } from "../src/server/deno-version.ts";

const REPO = new URL("../", import.meta.url).pathname;

/** The gate commands `release-check.ts` runs, read off its FAST/HEAVY lists
 *  as `deno task <name>` or `deno <verb> …` strings. */
async function releaseGates(): Promise<string[]> {
  const src = await Deno.readTextFile(REPO + "scripts/release-check.ts");
  const out: string[] = [];
  for (const list of ["FAST", "HEAVY"]) {
    const m = src.match(
      new RegExp(`const ${list}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`),
    );
    if (!m) throw new Error(`release-check.ts: no ${list} list`);
    for (const row of m[1]!.matchAll(/\[\s*"[^"]+",\s*\[([^\]]*)\]/g)) {
      const words = [...row[1]!.matchAll(/"([^"]*)"/g)].map((w) => w[1]!);
      out.push(words.join(" "));
    }
  }
  return out;
}

Deno.test("ci: every gate check:release runs is a CI step", async () => {
  const ci = await Deno.readTextFile(REPO + ".github/workflows/ci.yml");
  const steps = [...ci.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]!.trim());
  const gates = await releaseGates();
  assertEquals(gates.length > 10, true, "read the lists");
  const missing = gates.filter((g) => {
    // `deno task update:docs -- --check` is spelled the same way in both.
    return !steps.some((s) => s === g || s.startsWith(g + " "));
  });
  assertEquals(
    missing,
    [],
    `gates in scripts/release-check.ts with no \`run:\` step in ci.yml — add ` +
      `one (a slow gate may go in the scheduled \`heavy\` job, and say so)`,
  );
});

Deno.test("ci: the heavy tier is scheduled AND on demand, and says it is not on every push", async () => {
  const ci = await Deno.readTextFile(REPO + ".github/workflows/ci.yml");
  assertEquals(/^\s*schedule:/m.test(ci), true, "a nightly schedule");
  assertEquals(/^\s*workflow_dispatch:/m.test(ci), true, "on demand");
  assertEquals(
    /heavy:[\s\S]*?if:.*schedule.*workflow_dispatch/.test(ci),
    true,
    "the heavy job is gated on those two events",
  );
});

Deno.test("ci: the test matrix pins the SUPPORTED FLOOR, not a number", async () => {
  // `MIN_DENO` is what aio refuses to boot below; the matrix's extra
  // `include:` entry is what proves the suite actually passes there. Two
  // hand-kept numbers in two files, and ci.yml already claimed "a guard test
  // pins the two to each other" — it did not exist, so raising MIN_DENO would
  // have left CI proving the wrong floor, silently and indefinitely.
  const ci = await Deno.readTextFile(REPO + ".github/workflows/ci.yml");
  const include = ci.match(/^\s*include:\n([\s\S]*?)\n\s*runs-on:/m);
  assertEquals(!!include, true, "the test job must keep its `include:` block");
  const pinned = [...include![1]!.matchAll(/deno:\s*"?([\w.\-]+)"?/g)]
    .map((m) => m[1]!)
    .filter((v) => v !== "v2.x");
  assertEquals(
    pinned.includes(MIN_DENO),
    true,
    `.github/workflows/ci.yml must run the suite on the supported floor ` +
      `(MIN_DENO = ${MIN_DENO} in src/server/deno-version.ts); its matrix ` +
      `pins ${JSON.stringify(pinned)}. Raise both together.`,
  );
});

Deno.test("ci: check:release keeps its required lanes, and only the lab may skip", async () => {
  // The direction the first test cannot see: a lane DELETED from
  // release-check.ts leaves ci.yml a superset and that test green. These
  // lanes each hold a class nothing else runs — the hosts matrix, the SSR
  // overlap soak, the seeded sync properties, the dead-wiring ratchet (which
  // carries check:persist-decider), the mutation ledger, the frozen public
  // surface (check:api — the surface is additive-only, and this is the only
  // gate that sees a removed export), and the page's download size.
  const gates = await releaseGates();
  const REQUIRED = [
    "deno task test:hosts",
    "deno task test:ssr-soak",
    "deno task test:sync",
    "deno task check:dead-wiring",
    "deno task check:mutations",
    "deno task check:api",
    "deno task check:bundle-size",
  ];
  assertEquals(
    REQUIRED.filter((g) => !gates.includes(g)),
    [],
    "scripts/release-check.ts dropped a required release lane",
  );

  // check:persist-decider has no row of its own: it rides inside
  // check:dead-wiring. Removing the call there drops it from every gate.
  const dw = await Deno.readTextFile(REPO + "scripts/check-dead-wiring.ts");
  assertEquals(
    /check as persistCheck/.test(dw) &&
      /persistCheck\(\s*\(await readSources\(root\)\)/.test(dw),
    true,
    "scripts/check-dead-wiring.ts must still run check:persist-decider",
  );

  // Not skipped by default: every HEAVY row runs, unconditionally; the ONLY
  // result reported as SKIPPED is the docker-less lab, and it says so.
  const rc = await Deno.readTextFile(REPO + "scripts/release-check.ts");
  assertEquals(
    rc.includes(
      "for (const [name, cmd] of HEAVY) heavy.push(await run(name, cmd));",
    ),
    true,
    "every HEAVY row must run — no per-lane condition",
  );
  const skips = [
    ...rc.matchAll(/name:\s*"([^"]+)",\s*ok:\s*true,\s*detail:\s*"SKIPPED/g),
  ]
    .map((m) => m[1]);
  assertEquals(skips, ["lab (fresh ubuntu)"], "only the lab may SKIP, loudly");
  // …and the hosts lane runs its Electron host: the task sets both opt-ins
  // hosts.test.ts gates it on, so the lane is not a quiet subset of itself.
  const tasks = JSON.parse(await Deno.readTextFile(REPO + "deno.json")).tasks;
  const hosts = String(tasks["test:hosts"] ?? "");
  assertEquals(
    ["AIO_BUILD_E2E=1", "AIO_BUILD_ELECTRON=1", "tests/hosts.test.ts"]
      .filter((w) => !hosts.includes(w)),
    [],
    "deno.json test:hosts must run tests/hosts.test.ts with its Electron opt-ins",
  );
});

Deno.test("ci: the suite runs the ratchets first, and the ratchets keep check:report-dirs", async () => {
  // `deno task test` is the gate everyone runs, so the static ratchets ride
  // at its FRONT: a ratchet moved behind the suite (or out of it) is a ratchet
  // that runs only after 2.5 minutes of green — or never, when a shard fails.
  // And check:report-dirs is the one that keeps a private report directory
  // out of the public package (the 2026-09-22 history rewrite); it has no row
  // of its own in release-check.ts, so dropping it from check:ratchets would
  // drop it from every gate at once.
  const tasks = JSON.parse(await Deno.readTextFile(REPO + "deno.json")).tasks;
  const test = String(tasks["test"] ?? "");
  assertEquals(
    test.startsWith("deno task check:ratchets"),
    true,
    `deno.json \`test\` must start with \`deno task check:ratchets\`; it is: ${test}`,
  );
  const ratchets = String(tasks["check:ratchets"] ?? "");
  assertEquals(
    ratchets.includes("scripts/check-report-dirs.ts"),
    true,
    "deno.json check:ratchets must run scripts/check-report-dirs.ts",
  );
});

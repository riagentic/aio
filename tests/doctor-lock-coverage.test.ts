// `deno task doctor` says when the committed deno.lock misses aio's OWN tool
// dependencies (field report (a desktop map app) §5).
//
// A clone of one commit ran `am fix` and the lock grew by 58 lines — aio's
// jsr:@std/* and npm:react entries, several of them RANGES. Without them a
// later clone resolves aio's build/test tooling afresh, which is the drift the
// pin exists to prevent, and nothing noticed: `deno check src/` and `deno test`
// never load the framework's am/build/aiol modules.
//
// The fixture is a stand-in framework under `dep/aio` whose tool modules import
// packages the app itself never does — versions this repo already uses, so the
// global Deno cache has them and the test needs no network. A cold cache is a
// loud failure below, never a silent pass.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  aioToolEntries,
  checkLockCoverage,
} from "../src/server/lock-coverage.ts";
import { lockCoverageLine } from "../src/server/doctor.ts";
import { cacheTargets } from "../src/am/am-cmd-fix.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CFG = {
  imports: { "aio/testing": "./dep/aio/src/cell-test.ts" },
  tasks: {
    dev: "deno run -A src/app.ts",
    am: "deno run -A ./dep/aio/src/am.ts",
    build:
      "deno run -A ./dep/aio/src/build-all.ts --build-spec=./dep/aio/src/build.ts",
    test: "deno test -A",
  },
};

async function fixture(): Promise<string> {
  const dir = await tempDir("doctor-lock-");
  await Deno.mkdir(join(dir, "src"));
  await Deno.mkdir(join(dir, "dep/aio/src"), { recursive: true });
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(CFG));
  await Deno.writeTextFile(join(dir, "src/app.ts"), "export const x = 1;\n");
  // Tool-only dependencies: reached from a TASK (am.ts), from the build spec
  // named in a flag (build.ts), and from the import map (aio/testing).
  const mod = (spec: string) =>
    `import * as m from "${spec}";\nexport const _m = m;\n`;
  await Deno.writeTextFile(
    join(dir, "dep/aio/src/am.ts"),
    mod("jsr:@std/assert@1.0.19"),
  );
  await Deno.writeTextFile(join(dir, "dep/aio/src/build-all.ts"), "");
  await Deno.writeTextFile(
    join(dir, "dep/aio/src/build.ts"),
    mod("jsr:@std/jsonc@1.0.2"),
  );
  await Deno.writeTextFile(
    join(dir, "dep/aio/src/cell-test.ts"),
    mod("npm:immer@10.2.0"),
  );
  // The lock `deno check src/` leaves behind: the app's graph only.
  await Deno.writeTextFile(join(dir, "deno.lock"), `{"version":"5"}\n`);
  return dir;
}

Deno.test("doctor lock coverage: the tool entry list is read from tasks, flags and the import map", () => {
  assertEquals(aioToolEntries(CFG), [
    "src/app.ts",
    "./dep/aio/src/am.ts",
    "./dep/aio/src/build-all.ts",
    "./dep/aio/src/build.ts",
    "./dep/aio/src/cell-test.ts",
  ]);
  // JSR layout: the published package's run-only entries count too.
  assertEquals(
    aioToolEntries({
      tasks: { am: "deno run -A jsr:@riagentic/aio@1.0.11-beta/am" },
    }),
    ["src/app.ts", "jsr:@riagentic/aio@1.0.11-beta/am"],
  );
});

Deno.test("doctor lock coverage: a lock missing aio's tool entries is a WARN naming am fix, and is never written", async () => {
  const dir = await fixture();
  try {
    const before = await Deno.readTextFile(join(dir, "deno.lock"));
    const r = await checkLockCoverage(dir, CFG);
    assert(
      r.status === "missing",
      `expected missing entries, got ${JSON.stringify(r)}` +
        (r.status === "skipped"
          ? " — a cold Deno cache? run `deno cache` on this repo once"
          : ""),
    );
    for (
      const e of [
        "jsr:@std/assert@1.0.19",
        "jsr:@std/jsonc@1.0.2",
        "npm:immer@10.2.0",
      ]
    ) assert(r.missing.includes(e), `${e} not reported: ${r.missing}`);
    const line = await lockCoverageLine(dir);
    assertEquals(line?.ok, false);
    assertStringIncludes(line!.line, "WARN  deno.lock is missing");
    assertStringIncludes(line!.line, "run `am fix`");
    // Never written, and nothing else appears in the app folder.
    assertEquals(await Deno.readTextFile(join(dir, "deno.lock")), before);
    const names = (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name)
      .sort();
    assertEquals(names, ["deno.json", "deno.lock", "dep", "src"]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("doctor lock coverage: what am fix caches is the repair — after it, the line PASSes", async () => {
  const dir = await fixture();
  try {
    // `am fix`'s cache step loads exactly the doctor's list…
    const toCache = await cacheTargets(dir, "src/app.ts");
    assertEquals(toCache, aioToolEntries(CFG));
    // …and running it (what `am fix` does outside --dry-run) completes it.
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["cache", ...toCache],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(o.success, new TextDecoder().decode(o.stderr));
    const line = await lockCoverageLine(dir);
    assertEquals(line?.ok, true, line?.line);
    assertStringIncludes(line!.line, "PASS  deno.lock covers aio's tools");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("doctor lock coverage: no lock, or an unlinked dep/aio, is not called complete", async () => {
  const dir = await fixture();
  try {
    await Deno.remove(join(dir, "deno.lock"));
    assertEquals(await lockCoverageLine(dir), null);
    await Deno.writeTextFile(join(dir, "deno.lock"), `{"version":"5"}\n`);
    await Deno.remove(join(dir, "dep"), { recursive: true });
    const r = await checkLockCoverage(dir, CFG);
    assertEquals(r.status, "skipped");
    const line = await lockCoverageLine(dir);
    assertEquals(line?.ok, false);
    assertStringIncludes(line!.line, "not checked");
  } finally {
    await dropTempDir(dir);
  }
});

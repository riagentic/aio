// An app that top-level-awaits `aio.run()` must BOOT.
//
// alpha54 added two `await import(…)` calls inside `aio.run()` — for `updates`
// and `feedback` — chosen because `cell()` self-registers, so a static import
// would have put those cells in every app that never asked. But a dynamic
// import issued from inside a call the app top-level-awaits can leave module
// evaluation unable to complete, and Deno reports that as:
//
//   error: Module evaluation is still pending after multiple event loop
//   iterations, but no stalled top-level await was found. This is a bug in Deno.
//
// …which names neither aio nor the app. A user's working app stopped booting
// and the message pointed at the runtime. No test covered the shape, because
// every harness calls `aio.run()` from inside a test function rather than at a
// module's top level.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");
const dec = new TextDecoder();

/** Boot a real app whose ENTRY top-level-awaits aio.run(), and report what the
 *  process did. The top-level await is the whole point — a harness that wraps
 *  the call in a function cannot reproduce this. */
async function bootTopLevel(config: string): Promise<{
  code: number;
  out: string;
}> {
  const dir = await Deno.makeTempDir({ prefix: "aio-tla-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "tla-probe",
        version: "0.0.1",
        unstable: ["kv"],
        compilerOptions: {
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
        },
        imports: {
          aio: `${ROOT}/mod.ts`,
          immer: "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.3",
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { aio, cell } from "aio";
export const probe = cell("probe", {
  state: { n: 0 },
  methods: { async bump(s) { await Promise.resolve(); s.n++; } },
});
const app = await aio.run(${config});
console.log("BOOTED");
await app.close();
`,
    );
    const p = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "--no-lock",
        "src/app.ts",
        "--client=server-only",
        "--port=0",
      ],
      cwd: dir,
      env: { AIO_APPS_DIR: join(dir, "home") },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: p.code,
      out: dec.decode(p.stdout) + dec.decode(p.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "boot: top-level await aio.run() completes — plain app",
  async fn() {
    const r = await bootTopLevel(`{ persist: false }`);
    assert(r.out.includes("BOOTED"), `did not boot:\n${r.out.slice(-1500)}`);
    assertEquals(r.code, 0);
  },
});

Deno.test({
  name: "boot: top-level await aio.run() completes — with feedback",
  async fn() {
    // `feedback: true` is what pulled in the dynamic import.
    const r = await bootTopLevel(`{ persist: false, feedback: true }`);
    assert(
      !r.out.includes("Module evaluation is still pending"),
      `module evaluation deadlocked:\n${r.out.slice(-1500)}`,
    );
    assert(r.out.includes("BOOTED"), `did not boot:\n${r.out.slice(-1500)}`);
    assertEquals(r.code, 0);
  },
});

Deno.test("boot: nothing on the boot path dynamically imports a cell module", async () => {
  // The guard, not just the symptom. A dynamic import from inside the call an
  // app top-level-awaits is the hazard itself — the two cells that needed one
  // are factories now, registering on CALL so a static import stays safe.
  // Every file `aio.run()` awaits, not just aio.ts — `startUpdates` and
  // `startFeedback` had the same shape one call deeper, which is half a fix.
  const bad: string[] = [];
  for (
    const f of [
      "aio.ts",
      "aio-lifecycle.ts",
      "updates-boot.ts",
      "feedback-boot.ts",
    ]
  ) {
    const src = await Deno.readTextFile(join(ROOT, "src", "server", f));
    for (const m of src.matchAll(/await import\(\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (spec.includes("-cell") || spec.includes("-runtime")) {
        bad.push(`${f} → ${spec}`);
      }
    }
  }
  assertEquals(
    bad,
    [],
    "a cell module pulled in for its registration side effect can deadlock " +
      "module evaluation — use a factory and a static import",
  );
});

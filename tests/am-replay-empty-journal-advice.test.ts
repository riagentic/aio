// The advice `am replay` gives for an empty journal must be advice that works.
//
// It said "run the app with persist: false so nothing is compacted" — and
// `journal: true` with `persist: false` refuses to boot (there is no file to
// replay from). The advice now names what does keep a journal: a long
// `persistDebounceMs`, copied before a clean stop. Both halves are checked
// here against a real boot, not against the wording.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { cmdReplay } from "../src/am/am-cmd-timeline.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

class ExitSignal extends Error {}

async function adviceFor(journal: string): Promise<string> {
  const said: string[] = [];
  const l = console.log, e = console.error, exit = Deno.exit;
  console.log = (...a: unknown[]) => said.push(a.join(" "));
  console.error = (...a: unknown[]) => said.push(a.join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = () => {
    throw new ExitSignal();
  };
  try {
    await cmdReplay([`--from=${journal}`], {} as unknown as GlobalFlags);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    console.log = l;
    console.error = e;
    Deno.exit = exit;
    Deno.exitCode = 0; // outError marks the process failed — this refusal is the subject
  }
  return said.join("\n");
}

const counter = () =>
  cell("advice_counter", {
    state: { n: 0 },
    methods: {
      add(s, by: number) {
        s.n += by;
      },
    },
  });

Deno.test("am replay: the empty-journal advice boots and keeps a journal; the old advice does not boot", async () => {
  const dir = await tempDir("aio-replay-advice-");
  try {
    await Deno.writeTextFile(`${dir}/empty.journal`, "");
    const advice = await adviceFor(`${dir}/empty.journal`);
    assertStringIncludes(advice, "persistDebounceMs: 600_000");
    assert(!advice.includes("persist: false"), advice);

    // The old advice: refused at boot.
    _resetAioRuntime();
    await assertRejects(() =>
      aio.run({
        cells: [counter()],
        appId: "advice-old",
        journal: true,
        persist: false,
        dbPath: `${dir}/old.db`,
        libraryMode: true,
        client: "server-only",
        baseDir: dir,
      })
    );

    // A refused boot marks the process failed, as it should for an app.
    Deno.exitCode = 0;

    // The new advice: the journal holds the session's actions.
    _resetAioRuntime();
    const c = counter();
    const app = await aio.run({
      cells: [c],
      appId: "advice-new",
      journal: true,
      persistDebounceMs: 600_000,
      dbPath: `${dir}/new.db`,
      libraryMode: true,
      client: "server-only",
      baseDir: dir,
    });
    try {
      await (c as unknown as { add: (n: number) => Promise<void> }).add(7);
      await new Promise((r) => setTimeout(r, 150));
      const text = await Deno.readTextFile(`${dir}/new.db.journal`);
      assertStringIncludes(text, '"advice_counter:add"');
    } finally {
      await app.close();
      _resetAioRuntime();
    }
  } finally {
    await dropTempDir(dir);
  }
});

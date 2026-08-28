// The boot report's composition line, for an app that is headless but HAS a
// component, used to read:
//
//     headless (App.tsx present, not served — --client=server-only)
//
// whatever the client actually was. `isHeadless` is
// `client === "server-only" || client === "cli"` — two reasons — and the line
// hardcoded the first. So an app launched with `--client=cli` was told about a
// flag it had not passed, one line above the boot report printing
// `cli: --client=cli`.
//
// The comment directly above that line already states the rule it broke: "Say
// what is TRUE, not what is usually true" — written when the same line claimed
// "no App.tsx" next to the file sitting right there.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { lint } from "../src/server/lint.ts";

const STATE = { n: 0 };
const CONFIG = { reduce: () => {}, execute: () => {} };

/** A baseDir that does or does not hold a component. */
async function withApp(
  hasUi: boolean,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-headless-" });
  if (hasUi) await Deno.writeTextFile(join(dir, "App.tsx"), "export default 1");
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** The `headless (...)` entry of the composition line. */
function headlessLine(ok: string[]): string {
  return ok.find((l) => l.startsWith("headless")) ?? "(no headless entry)";
}

Deno.test("headless: the line names the client that made it headless", async () => {
  for (const client of ["cli", "server-only"]) {
    await withApp(true, async (dir) => {
      const r = await lint(
        STATE,
        CONFIG,
        dir,
        false,
        true,
        true,
        "App.tsx",
        client,
      );
      assertStringIncludes(headlessLine(r.ok), `--client=${client}`);
    });
  }
});

Deno.test("headless: with no component, the reason is the missing file", async () => {
  // Unchanged: naming a client here would answer a question nobody asked —
  // the component is simply not there.
  await withApp(false, async (dir) => {
    const r = await lint(
      STATE,
      CONFIG,
      dir,
      false,
      true,
      true,
      "App.tsx",
      "cli",
    );
    assertEquals(headlessLine(r.ok), "headless (no App.tsx)");
  });
});

Deno.test("headless: an unknown client attributes the choice to nobody", async () => {
  // `checkCells` is public surface and the parameter is optional, so a caller
  // that does not pass it must still get a true sentence — just a shorter one.
  await withApp(true, async (dir) => {
    const r = await lint(STATE, CONFIG, dir, false, true, true, "App.tsx");
    const line = headlessLine(r.ok);
    assertEquals(line, "headless (App.tsx present, not served)");
    assertEquals(line.includes("--client"), false, "invented a flag");
  });
});

// `am ui` opens amui (the visual app manager) — the rename that killed the
// worst-named command of the fifty: `ui` used to print the server-side
// UI-STATE PROJECTION, which now lives at `am state --ui` (pinned in
// am.test.ts against a live trojan server). Everything here is spawn-FREE:
// the argv/spec construction is pure, so CI never launches Electron.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  amuiDenoArgs,
  amuiEntry,
  cmdUi,
  detachedSpawnSpec,
} from "../src/am/am-cmd-process.ts";
import { cmdHelp } from "../src/am/am-cmd-meta.ts";
import { parseGlobalFlags } from "../src/am/am-utils.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const REPO_ROOT = resolve(import.meta.dirname!, "..");

Deno.test("am ui: resolves the amui entry beside this am's checkout", async () => {
  assertEquals(
    amuiEntry(REPO_ROOT),
    join(REPO_ROOT, "amui", "src", "app.ts"),
    "the repo checkout carries amui/",
  );
  // No root (bare JSR global) or a root without amui/ → null, so cmdUi fails
  // loud naming the fallback instead of spawning nothing.
  assertEquals(amuiEntry(undefined), null);
  const empty = await Deno.makeTempDir({ prefix: "amui-absent-" });
  try {
    assertEquals(amuiEntry(empty), null);
  } finally {
    await Deno.remove(empty, { recursive: true }).catch(() => {});
  }
});

Deno.test("am ui: the spawn argv passes args through and forces no client", () => {
  const entry = "/x/aio/amui/src/app.ts";
  // Default: amui's own deno.json decides the shell (electron) — am must not
  // override it.
  assertEquals(amuiDenoArgs(entry, []), ["run", "-A", entry]);
  // `am ui --client=browser` reaches amui verbatim.
  assertEquals(amuiDenoArgs(entry, ["--client=browser"]), [
    "run",
    "-A",
    entry,
    "--client=browser",
  ]);
  // …and the detached spec (the same per-OS machinery `am start` uses) really
  // carries that argv.
  const spec = detachedSpawnSpec(
    "linux",
    amuiDenoArgs(entry, ["--client=browser"]),
    "/tmp/amui.log",
  );
  assertEquals(spec.cmd, "sh");
  assertStringIncludes(spec.args.join(" "), entry);
  assertStringIncludes(spec.args.join(" "), "--client=browser");
  assertStringIncludes(spec.args.join(" "), "nohup");
});

Deno.test("am ui: `--client=browser` survives am's global flag parse", () => {
  // am's own (deprecated) client-INDEX flag was `--client=N` — a runtime
  // `--client=<kind>` must not be eaten by it, or `am ui --client=browser`
  // could never reach amui.
  const r = parseGlobalFlags(["ui", "--client=browser"]);
  assertEquals(r.command, "ui");
  assertEquals(r.args, ["--client=browser"]);
  assertEquals(r.flags.client, undefined);
  assertEquals(r.flags.error, undefined);
  // `state --ui` parses as the flag, not a positional.
  const s = parseGlobalFlags(["state", "--ui", "alice"]);
  assertEquals(s.command, "state");
  assertEquals(s.flags.ui, true);
  assertEquals(s.args, ["alice"]);
});

Deno.test("am ui: the OLD usage (`am ui <user>`) points at `am state --ui`, launches nothing", async () => {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  const origExit = Deno.exit;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  let code: number | undefined;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    code = c ?? 0;
    throw new Error("exit-stub");
  };
  try {
    await cmdUi(["alice"], { json: true } as GlobalFlags).catch((e) => {
      if (!String(e).includes("exit-stub")) throw e;
    });
    assertEquals(code, 1, "old usage is a refusal, not a surprise Electron");
    assert(
      lines.some((l) => l.includes("am state --ui alice")),
      `the pointer must name the new spelling, got: ${lines.join(" | ")}`,
    );
  } finally {
    console.error = origErr;
    console.log = origLog;
    Deno.exit = origExit;
  }
});

Deno.test("am help: lists the launcher AND the moved projection", () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    cmdHelp([], {} as GlobalFlags, []);
  } finally {
    console.log = orig;
  }
  const text = lines.join("\n");
  assertStringIncludes(text, "Open amui");
  assertStringIncludes(text, "state --ui");
  assert(
    !/^\s*ui \[user\]/m.test(text),
    "the old `ui [user]` help line is gone",
  );
});

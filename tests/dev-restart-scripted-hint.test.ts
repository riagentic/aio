// A save restarts every running dev app, and that ends a scripted run (a UI
// tour, a screenshot pass). `--no-watch` is the switch for it; a field report
// lived for weeks with a house rule instead — "no source edits while a run is
// up" — because nothing named the switch where the restart is announced.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { scriptedRunHint } from "../src/server/dev-restart.ts";

Deno.test("dev restart: a command line that reads as a script's is told about --no-watch", () => {
  for (
    const args of [
      ["--cdp"],
      ["--cdp=9333"],
      ["--client=server-only"],
      ["--port=8000", "--client=server-only", "--expose"],
    ]
  ) {
    assertStringIncludes(scriptedRunHint(args, false), "--no-watch");
  }
});

Deno.test("dev restart: a plain dev start gets no hint, and a relaunched app does not repeat it", () => {
  for (
    const args of [
      [],
      ["--port=8000"],
      ["--client=electron"],
      ["--no-cdp"],
      ["--cdpx"],
    ]
  ) {
    assertEquals(scriptedRunHint(args, false), "", args.join(" "));
  }
  // Every later restart of the session happens in a supervised child.
  assertEquals(scriptedRunHint(["--cdp"], true), "");
});

Deno.test("dev restart: the hint is said where the restart is announced", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/dev-restart.ts", import.meta.url),
  );
  const at = src.indexOf("— restarting the app`);");
  assert(at > 0);
  const next = src.slice(at, at + 400);
  assertStringIncludes(
    next,
    "scriptedRunHint(Deno.args, isSupervisedChild())",
  );
  assertStringIncludes(next, 'if (hint) log.info("watch", hint);');
});

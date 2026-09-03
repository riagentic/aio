// `am link` reported "(pinned in deno.json)" for a pin that lives in the
// git-ignored `.aio/pin.local`. Doctor already got this right, from the same
// reader — the two lines disagreed, and the wrong one is the one a developer
// acts on (they open deno.json and find no pin at all).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _linkTarget } from "../src/am/am-cmd-link.ts";
import {
  LOCAL_PIN_FILE,
  readFrameworkPinSync,
} from "../src/server/deno-json.ts";

Deno.test("am link: a path pin names .aio/pin.local, a release pin names deno.json", () => {
  assertStringIncludes(
    _linkTarget({
      pin: "path:/src/aio",
      pinSource: "local",
      root: "/src/aio",
      explicitRoot: false,
    }),
    LOCAL_PIN_FILE,
  );
  assertStringIncludes(
    _linkTarget({
      pin: "v1.2.3",
      pinSource: "deno.json",
      root: "/x",
      explicitRoot: false,
    }),
    "pinned in deno.json",
  );
  assertStringIncludes(
    _linkTarget({
      pin: null,
      pinSource: null,
      root: "/x",
      explicitRoot: true,
    }),
    "--aio override",
  );
  assertStringIncludes(
    _linkTarget({
      pin: null,
      pinSource: null,
      root: "/x",
      explicitRoot: false,
    }),
    "am pin latest",
  );
});

Deno.test("am link: the source it reports is the one THE reader resolved", async () => {
  // End to end through readFrameworkPin — the same predicate doctor uses, so
  // the two commands can never drift apart again.
  const dir = await Deno.makeTempDir({ prefix: "aio-link-pin-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ aioVersion: "v1.2.3" }),
    );
    await Deno.mkdir(join(dir, ".aio"));
    // The reader verifies the target IS a checkout (mod.ts), so point it at
    // this one.
    const checkout = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(join(dir, LOCAL_PIN_FILE), checkout + "\n");
    const { pin, source } = readFrameworkPinSync(dir);
    assertEquals(source, "local", "the local override wins over aioVersion");
    const line = _linkTarget({
      pin,
      pinSource: source,
      root: checkout,
      explicitRoot: false,
    });
    assertStringIncludes(line, LOCAL_PIN_FILE);
    assert(
      !line.includes("pinned in deno.json"),
      `deno.json still says v1.2.3 — naming it here is the lie. Got: ${line}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

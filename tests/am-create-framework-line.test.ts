// `am create` says which framework the new app runs. The F3 benchmark agent
// found `dep/aio` pointing at the installed release rather than the checkout
// it expected, and "nothing said this would happen".
import { assertEquals, assertStringIncludes } from "@std/assert";
import { frameworkSentence } from "../src/am/am-cmd-create.ts";
import { VERSION } from "../src/server/aio-cli.ts";

Deno.test("am create: the framework line names the pin, the link, and the way to a local tree", () => {
  const pinned = frameworkSentence(
    "v1.0.5-beta",
    "/home/u/.local/lib/aio-versions/v1.0.5-beta",
    false,
  );
  assertStringIncludes(pinned, "aio v1.0.5-beta (release pin)");
  assertStringIncludes(
    pinned,
    "dep/aio → /home/u/.local/lib/aio-versions/v1.0.5-beta",
  );
  assertStringIncludes(pinned, "--mirror=<checkout>");
  assertEquals(
    frameworkSentence("path:/src/aio", "/src/aio", true),
    "framework: your checkout, live · dep/aio → /src/aio",
  );
  assertEquals(
    frameworkSentence(undefined, undefined, false),
    `framework aio ${VERSION} from JSR (--jsr)`,
  );
});

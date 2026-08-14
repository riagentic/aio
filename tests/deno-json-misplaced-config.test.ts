// aio config in the WRONG file, said out loud.
//
// `aio.run({ nonsense: 1 })` refuses at boot and prints the whole valid config.
// The same keys at the top level of deno.json were accepted, did nothing, and
// said nothing — a field report put `ui: { width, height }` there, lost time to
// it, and it ended up as a bullet in THEIR docs instead of a message from us:
// "silently ignoring input is the worst available behaviour".
//
// The rule has to be narrow, though: deno.json is Deno's file and other tools
// keep sections in it. Only a key aio would recognise inside `aio.run()`
// counts.
import { assertEquals } from "@std/assert";
import {
  DENO_JSON_READ_KEYS,
  misplacedDenoJsonKeys,
} from "../src/server/config.ts";

Deno.test("deno.json: `ui` at the top level is reported — the field-report case", () => {
  assertEquals(
    misplacedDenoJsonKeys({
      name: "my-app",
      tasks: { dev: "deno run -A src/app.ts" },
      ui: { width: 1200, height: 800 },
    }),
    ["ui"],
  );
});

Deno.test("deno.json: several aio keys are all named at once", () => {
  assertEquals(
    misplacedDenoJsonKeys({
      auth: true,
      port: 3000,
      logging: { level: "debug" },
      imports: {},
    }).sort(),
    ["auth", "logging", "port"],
  );
});

Deno.test("deno.json: the keys aio DOES read are never reported", () => {
  assertEquals(
    misplacedDenoJsonKeys({
      appId: "wallet",
      title: "Wallet",
      client: "electron",
      entry: "src/app.ts",
      build: { channel: "stable" },
      version: "1.2.3",
    }),
    [],
    "identity and build live in deno.json BY DESIGN — flagging them would " +
      "make the warning noise, and noise is what this rule removes",
  );
});

Deno.test("deno.json: another tool's section is left alone", () => {
  assertEquals(
    misplacedDenoJsonKeys({
      eslintConfig: { rules: {} },
      myCompanyThing: { x: 1 },
      $schema: "https://deno.land/x/deno/cli/schemas/config-file.v1.json",
    }),
    [],
    "aio does not own this file and must not scold every key in it",
  );
});

Deno.test("deno.json: no file, no complaint", () => {
  assertEquals(misplacedDenoJsonKeys(undefined), []);
  assertEquals(misplacedDenoJsonKeys({}), []);
});

Deno.test("deno.json: `title` is read here AND valid in ui — no false positive", () => {
  // `title` is the overlap case: a UiConfig key that deno.json legitimately
  // carries. The read-list has to win, or every app with a window title would
  // be told its title does nothing.
  assertEquals(DENO_JSON_READ_KEYS.has("title"), true);
  assertEquals(misplacedDenoJsonKeys({ title: "Wallet" }), []);
});

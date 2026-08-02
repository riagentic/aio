// least-privilege capability manifest (the structural half of
// `aio ship`): scan what the app actually uses and emit the minimal --allow-*
// set instead of -A.
import { assert, assertEquals } from "@std/assert";
import {
  type Capabilities,
  manifestReport,
  permissionFlags,
  scanCapabilities,
} from "../src/build/capabilities.ts";

Deno.test("scanCapabilities: detects each category from real API usage", () => {
  const caps = scanCapabilities([
    { content: `const r = await fetch("https://api.x");` }, // net
    { content: `await Deno.readTextFile("./x");` }, // read
    { content: `await Deno.writeTextFile("./y", "z");` }, // write
    { content: `const lib = Deno.dlopen(path, {});` }, // ffi (USB/HID)
    { content: `const k = Deno.env.get("K");` }, // env
    { content: `new Deno.Command("ls");` }, // run
    { content: `Deno.hostname();` }, // sys
  ]);
  assertEquals(caps, {
    net: true,
    read: true,
    write: true,
    ffi: true,
    env: true,
    run: true,
    sys: true,
  });
});

Deno.test("scanCapabilities: a pure app needs nothing (never -A)", () => {
  const caps = scanCapabilities([
    { content: `export const add = (a: number, b: number) => a + b;` },
  ]);
  assertEquals(permissionFlags(caps), []);
});

Deno.test("scanCapabilities: a mention in a COMMENT does not grant a permission", () => {
  const caps = scanCapabilities([
    {
      content:
        `// this used to call Deno.dlopen and fetch(); now it doesn't\nexport const x = 1;`,
    },
  ]);
  assertEquals(caps.ffi, false);
  assertEquals(caps.net, false);
});

Deno.test("permissionFlags: emits only the needed allow-flags, never -A", () => {
  const caps: Capabilities = {
    net: true,
    read: true,
    write: false,
    ffi: true,
    env: false,
    run: false,
    sys: false,
  };
  const flags = permissionFlags(caps);
  assertEquals(flags, ["--allow-net", "--allow-read", "--allow-ffi"]);
  assert(!flags.includes("-A"));
});

Deno.test("manifestReport: lists flags + the reason each was included", () => {
  const report = manifestReport(scanCapabilities([
    { content: `Deno.dlopen(p, {}); fetch("x");` },
  ]));
  assert(report.includes("--allow-ffi"));
  assert(report.includes("USB/HID"));
  assert(report.includes("--allow-net"));
  assert(report.includes("replaces -A"));
});

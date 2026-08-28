// least-privilege capability manifest (the structural half of
// `aio ship`): scan what the app actually uses and emit the minimal --allow-*
// set instead of -A.
import { assert, assertEquals } from "@std/assert";
import {
  _SCANNED_FS_APIS,
  type Capabilities,
  scanCapabilities,
} from "../src/build/capabilities.ts";
import { manifestReport, permissionFlags } from "../src/testing/internal.ts";

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

// ── the *Sync spellings, and the list that keeps them honest ─────────
//
// `\b` does not sit between `e` and `S`, so `readFile` never matched inside
// `readFileSync`: an app whose I/O is the sync spellings scanned to
// read:false/write:false and its signed manifest advertised `runFlags: []`.
// Following that advice launched a binary that died on PermissionDenied at its
// first file read — the manifest is the security artifact, so a too-narrow
// scan is a broken product, not a conservative one.
Deno.test("scanCapabilities: the *Sync spellings count — every scanned FS API, both ways", () => {
  for (const api of _SCANNED_FS_APIS) {
    for (const name of [api, `${api}Sync`]) {
      const caps = scanCapabilities([{ content: `Deno.${name}("./x");` }]);
      assert(
        caps.read || caps.write,
        `Deno.${name} must require a file permission — it scanned to none`,
      );
    }
  }
});

Deno.test("scanCapabilities: an app written entirely in *Sync APIs is not permission-free", () => {
  const caps = scanCapabilities([{
    content: `const cfg = Deno.readTextFileSync("./config.json");
Deno.mkdirSync("./out");
Deno.writeTextFileSync("./out/report.json", cfg);`,
  }]);
  assertEquals(caps.read, true);
  assertEquals(caps.write, true);
  assertEquals(permissionFlags(caps), ["--allow-read", "--allow-write"]);
});

// One decider: the exported list and the regexes that do the matching must name
// the same APIs. A name added to a regex but not the list (or the reverse) is
// how the two drift apart, and drift here is invisible until a shipped binary
// dies on a permission it was told it did not need.
Deno.test("capabilities: the scanned-API list and the read/write regexes agree", () => {
  const source = Deno.readTextFileSync(
    new URL("../src/build/capabilities.ts", import.meta.url),
  );
  const inRegex = new Set<string>();
  // The signals read `\bDeno\.(?:a|b|c)…` — pull the alternation apart.
  for (const m of source.matchAll(/Deno\\\.\(\?:([A-Za-z|]+)\)/g)) {
    for (const name of m[1]!.split("|")) inRegex.add(name);
  }
  // Only the FS categories are listed — net/sys names live in their own signals.
  const listed = new Set(_SCANNED_FS_APIS);
  for (const name of listed) {
    assert(
      inRegex.has(name),
      `_SCANNED_FS_APIS names ${name}, but no signal regex matches it`,
    );
  }
  const fsOnly = [...inRegex].filter((n) =>
    !["connect", "listen", "serve", "connectTls", "listenTls"].includes(n) &&
    ![
      "hostname",
      "osRelease",
      "systemMemoryInfo",
      "networkInterfaces",
      "loadavg",
      "osUptime",
      "uid",
      "gid",
    ].includes(n)
  );
  for (const name of fsOnly) {
    assert(
      listed.has(name),
      `a signal regex matches Deno.${name}, but _SCANNED_FS_APIS omits it — ` +
        `add it so the Sync-spelling guard above covers it too`,
    );
  }
});

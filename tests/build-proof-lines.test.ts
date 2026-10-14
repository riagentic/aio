// A build names what aio has ON RECORD for a target outside its release
// gates — from the proof matrix the framework ships.
//
// Every release is built and booted on Linux. A build that went green for
// Windows, macOS, Android or iOS read exactly like the Linux one, and which
// of those had ever been run where it runs was a file in the repo
// (`deno task check:proof`) no installed framework could print.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { proofLines } from "../src/build/platforms.ts";

const ROWS = [
  { target: "windows", env: "wine", date: "2026-09-07" },
  { target: "windows", env: "native suite", date: "2026-10-01" },
  { target: "android", env: "emulator", date: "2026-09-22" },
  { target: "web", env: "real-browser", date: "2026-10-10" },
];

Deno.test("proofLines: one line per target outside the gates — its recorded runs, or that there is none; nothing for what the gates boot", () => {
  // Linux — server, browser page, desktop, web folder: the gates themselves.
  assertEquals(
    proofLines(
      ["server", "browser", "electron", "web", "cli-client", "binary"]
        .map((kind) => ({ kind, os: "linux" })),
      ROWS,
    ),
    [],
  );
  const lines = proofLines(
    [
      { kind: "electron", os: "windows" },
      { kind: "server", os: "windows" }, // one line per target, not per build
      { kind: "electron", os: "darwin" },
      { kind: "android", os: "linux" },
      { kind: "android-client", os: "linux" },
      { kind: "ios-client", os: "linux" },
    ],
    ROWS,
  );
  assertEquals(lines.map(([t, recorded]) => [t.split(":")[0], recorded]), [
    ["windows", true],
    ["macos", false],
    ["android", true],
    ["ios route", false],
  ]);
  assertStringIncludes(
    lines[0]![0],
    "wine 2026-09-07, native suite 2026-10-01",
  );
  assertStringIncludes(lines[1]![0], "no recorded run");
  // An unknown OS (a platform this table does not name) claims nothing.
  assertEquals(proofLines([{ kind: "server", os: undefined }], ROWS), []);
});

Deno.test("proofLines: the matrix the framework ships is the repo's own — published, and in the shape the lines read", async () => {
  const root = fromFileUrl(new URL("../", import.meta.url));
  const rows = JSON.parse(await Deno.readTextFile(root + "proof-matrix.json"));
  assert(Array.isArray(rows) && rows.length > 0);
  for (const r of rows) {
    assertEquals(
      [typeof r.target, typeof r.env, typeof r.date],
      ["string", "string", "string"],
    );
  }
  // What `deno publish` leaves out is listed; the matrix must not be on it.
  const { publish } = JSON.parse(await Deno.readTextFile(root + "deno.json"));
  assert(
    !publish.exclude.some((p: string) =>
      p === "proof-matrix.json" || p === "*.json"
    ),
    "proof-matrix.json is excluded from the published package",
  );
  assertStringIncludes(
    await Deno.readTextFile(root + "src/build-all.ts"),
    `import PROOF from "../proof-matrix.json" with { type: "json" };`,
  );
});

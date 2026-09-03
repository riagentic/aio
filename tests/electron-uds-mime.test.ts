// The packaged Electron window serves dist/ from disk, not through the server —
// so it needs a MIME table of its own inside the generated `main.cjs`. What it
// had was a hand-retyped 10-entry subset of the server's 26, and the two had
// drifted: a font, a .webp, an .mp4 or a .pdf in dist/ came back as
// application/octet-stream in the packaged app (browsers refuse the font and
// the media outright) while `deno task dev`, which goes through the server,
// served all of them correctly. A silent dev/prod divergence with nothing
// gating the pair. The generator now emits the server's own table; this test
// is what makes "the same table" true rather than aspirational.
import { assert, assertEquals } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { MIME } from "../src/server/server-html-constants.ts";

const script = electronMainScriptUDS("http://localhost:3000", "/tmp/t.sock", {
  title: "mime",
});

/** The table as the generated CJS file actually declares it. */
function emittedTable(src: string): Record<string, string> {
  const m = src.match(/\nconst MIME = (\{.*?\});\n/);
  assert(m, "the generated script must declare a MIME table");
  return JSON.parse(m[1]!) as Record<string, string>;
}

Deno.test("electron uds: the emitted MIME table IS the server's", () => {
  assertEquals(
    emittedTable(script),
    MIME,
    "the packaged window must resolve every content type the server does — " +
      "add extensions to src/server/server-html-constants.ts, never here",
  );
});

Deno.test("electron uds: the extensions the drift cost are served", () => {
  const emitted = emittedTable(script);
  // Every one of these was missing from the retyped copy. Named explicitly so
  // a future "trim the table" cannot quietly re-open the same hole.
  for (
    const ext of [
      ".woff2",
      ".woff",
      ".ttf",
      ".otf",
      ".webp",
      ".mp4",
      ".webm",
      ".mp3",
      ".pdf",
      ".gif",
      ".jpeg",
    ]
  ) {
    assertEquals(
      emitted[ext],
      MIME[ext],
      `${ext} must not fall back to application/octet-stream in a packaged app`,
    );
  }
  // The fallback stays — an unknown extension is still octet-stream.
  assert(
    script.includes("MIME[ext] || 'application/octet-stream'"),
    "unknown extensions keep the octet-stream fallback",
  );
});

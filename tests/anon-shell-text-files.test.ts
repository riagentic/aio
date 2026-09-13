// On an `auth: true` app a text file under baseDir is app DATA, not shell.
//
// `.txt` was in the anonymous shell's extension list, beside a `SHELL_FILES`
// entry for `robots.txt` that only means something if `.txt` is data-ish (that
// list's own doc says so). Measured with no credential: `GET /notes.txt` → 200
// and the file. Nothing a sign-in page loads is a text file. Meanwhile the
// public-by-convention files under `/.well-known/` were decided by extension,
// so Android's `assetlinks.json` answered 401 on every `auth: true` app.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { isShellAsset } from "../src/server/server-static.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

Deno.test("isShellAsset: .txt is data; robots/humans and /.well-known/ are public", () => {
  for (const p of ["/notes.txt", "/exports/customers.txt", "/NOTES.TXT"]) {
    assertEquals(isShellAsset(p, false), false, p);
    assertEquals(isShellAsset(p, true), false, `${p} (dev)`);
  }
  for (
    const p of [
      "/robots.txt",
      "/humans.txt",
      "/.well-known/security.txt",
      "/.well-known/assetlinks.json",
      "/.well-known/acme-challenge/abc",
    ]
  ) assertEquals(isShellAsset(p, false), true, p);
});

Deno.test("auth: true — anonymous GET of a text file is 401; the shell still renders", async () => {
  _resetAuthFails();
  const base = await Deno.makeTempDir({ prefix: "aio-anon-txt-" });
  try {
    await Deno.writeTextFile(join(base, "notes.txt"), "PRIVATE NOTES");
    await Deno.writeTextFile(join(base, "robots.txt"), "User-agent: *");
    await Deno.mkdir(join(base, ".well-known"));
    await Deno.writeTextFile(
      join(base, ".well-known", "assetlinks.json"),
      "[]",
    );
    await Deno.writeTextFile(join(base, "style.css"), "body{}");
    await using srv = await testServer({
      cells: [cell("anon_txt", { state: { n: 0 }, methods: {} })],
      baseDir: base,
      auth: true,
    });
    const notes = await srv.fetch("/notes.txt");
    const body = await notes.text();
    assertEquals(notes.status, 401);
    assertEquals(body.includes("PRIVATE NOTES"), false);
    for (
      const [p, want] of [
        ["/robots.txt", "User-agent"],
        ["/.well-known/assetlinks.json", "[]"],
        ["/style.css", "body{}"],
        ["/", "<html"],
      ] as const
    ) {
      const r = await srv.fetch(p);
      const t = await r.text();
      assertEquals(r.status, 200, p);
      assertEquals(t.includes(want), true, `${p}: ${t.slice(0, 80)}`);
    }
  } finally {
    _resetAuthFails();
    await Deno.remove(base, { recursive: true });
  }
});

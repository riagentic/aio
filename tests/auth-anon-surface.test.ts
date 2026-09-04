// The anonymous surface of an app that HAS accounts — the second auth hunt.
//
// `authFlows` (`auth: true`) makes the app SHELL public so the sign-in page can
// render. The anonymous branch carved out snapshot, blobs, diagnostics, the
// trojan and app routes… and then handed everything else to `serveStatic`, so
// every non-dotfile, non-`*.server.ts` file under `baseDir` was readable with
// no credential, at any depth. The same paths on a `users:` app answer 401.
// Worst case is `--expose` + `auth: true` — the recommended internet-facing
// config — i.e. an unauthenticated read of the project directory.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import {
  blobContentType,
  isShellAsset,
  logSafe,
} from "../src/server/server-static.ts";

// ── The rules, as pure functions ──────────────────────────────────────

Deno.test("isShellAsset: the SHELL is public, the app's data is not", () => {
  for (
    const p of [
      "/",
      "/some/client/route",
      "/app.js",
      "/app.js.map",
      "/style.css",
      "/logo.png",
      "/fonts/Inter.woff2",
      "/favicon.ico",
      "/manifest.json",
      "/__aio/ui.js",
    ]
  ) assert(isShellAsset(p, false), `${p} must stay public (shell)`);

  for (
    const p of [
      "/data/app.db",
      "/backup.sql",
      "/customers.csv",
      "/notes.md",
      "/config.json",
      "/dump.tar.gz",
      "/private/keys.pem",
    ]
  ) assert(!isShellAsset(p, false), `${p} is app DATA and must need a session`);

  // Dev serves sources by name (the shell's import map fetches them), so the
  // sign-in page can render; prod's `isProtectedPath` denies them to everyone.
  assert(isShellAsset("/App.tsx", true));
  assert(!isShellAsset("/App.tsx", false));
});

Deno.test("blobContentType: only inert types keep their type", () => {
  assertEquals(blobContentType("cat.png"), "image/png");
  assertEquals(blobContentType("clip.mp4"), "video/mp4");
  assertEquals(blobContentType("doc.pdf"), "application/pdf");
  assertEquals(blobContentType("notes.txt"), "text/plain");
  // The two that execute script in the app's ORIGIN when navigated to. The
  // type used to come straight from the uploaded filename, and
  // `docs/persistence/big-data.md` shows exactly that pattern.
  assertEquals(blobContentType("evil.html"), "application/octet-stream");
  assertEquals(blobContentType("evil.svg"), "application/octet-stream");
  assertEquals(blobContentType("x.js"), "application/octet-stream");
  assertEquals(blobContentType(undefined), "application/octet-stream");
});

Deno.test("logSafe: a client-supplied string cannot forge a second log line", () => {
  assertEquals(
    logSafe("admin logged in from 10.0.0.1\nWARN  fake line"),
    "admin logged in from 10.0.0.1 WARN  fake line",
  );
  assertEquals(logSafe("a\r\nb\tc d"), "a b c d");
  assertEquals(logSafe(undefined), undefined);
  assertEquals(logSafe(123 as unknown), undefined);
  assert((logSafe("x".repeat(5000)) ?? "").length <= 2001);
});

// ── The rule, end to end ──────────────────────────────────────────────

Deno.test("auth: true — an anonymous caller gets the shell, never the directory", async () => {
  _resetAuthFails();
  const { aio, cell } = await import("../mod.ts");
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "data"), { recursive: true });
  await Deno.writeTextFile(join(dir, "data", "app.db"), "PRIVATE-ROWS");
  await Deno.writeTextFile(join(dir, "notes.md"), "internal roadmap");
  await Deno.writeTextFile(join(dir, "customers.csv"), "a@b.c");
  await Deno.writeTextFile(join(dir, "app.css"), "body{}");
  const port = freePort();
  const app = await aio.run({
    cells: [cell("c_anon", { state: { n: 0 }, methods: {} })],
    appId: `test-anon-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port,
    baseDir: dir,
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (const p of ["/data/app.db", "/notes.md", "/customers.csv"]) {
      const r = await fetch(base + p);
      assertEquals(r.status, 401, `${p} was served anonymously`);
      const body = await r.text();
      assert(
        body.includes("app DATA"),
        `${p}: the refusal must say what to do instead — got ${body}`,
      );
    }
    // The shell itself still renders, which is the whole point of the mode.
    const shell = await fetch(base + "/");
    assertEquals(shell.status, 200);
    await shell.body?.cancel();
    const css = await fetch(base + "/app.css");
    assertEquals(css.status, 200, "the sign-in page's own CSS must load");
    await css.body?.cancel();
  } finally {
    await app.close();
    _resetAuthFails();
  }
});

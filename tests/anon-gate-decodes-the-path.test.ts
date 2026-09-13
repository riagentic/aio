// The anonymous shell gate and the file layer must decide on the SAME path.
//
// `SHELL_EXT`'s own header states the stakes: "Worst case is `--expose` +
// `auth: true`, the recommended internet-facing config: an unauthenticated
// read of the project directory."
//
// The gate ran on the RAW pathname; `serveFile` runs on the percent-DECODED
// one. One `%2E` put them on opposite sides of the same question:
// `isShellAsset("/data/app%2Edb")` finds no `.` in the last segment, takes the
// "extensionless → a client route" branch and answers true, while the file
// layer decodes it and serves `data/app.db`. Measured under `auth: true` with
// no credential sent:
//
//   GET /data/app.db      → 401        GET /data/app%2Edb    → 200, the database
//   GET /customers.csv    → 401        GET /customers%2Ecsv  → 200, the rows
//
// Two deciders, two spellings. There is one now, and a path that cannot be
// decoded fails CLOSED.
//
// The second half is the same class on a different axis: both protected-path
// patterns were case-SENSITIVE, so `secrets.Server.ts` walked past the
// `*.server.ts` rule on Linux — and on APFS/NTFS, both shipped desktop
// targets, `GET /secrets.server.TS` opens `secrets.server.ts`.
import { assert, assertEquals } from "@std/assert";
import { isProtectedPath, isShellAsset } from "../src/server/server-static.ts";

Deno.test("anon gate: an encoded dot does not turn app DATA into a client route", () => {
  for (
    const [raw, why] of [
      ["/data/app%2Edb", "a database"],
      ["/data/app%2edb", "…in lower case too"],
      ["/customers%2Ecsv", "an export"],
      ["/backup%2Ezip", "an archive"],
    ] as [string, string][]
  ) {
    assertEquals(
      isShellAsset(raw, false),
      false,
      `${raw} (${why}) must not read as a shell asset`,
    );
  }
});

Deno.test("anon gate: real shell assets and client routes still pass", () => {
  // The control — a gate that refused everything would pass the test above and
  // make the sign-in page unrenderable, which is the reason the gate exists.
  for (
    const p of [
      "/index.html",
      "/app.js",
      "/style.css",
      "/users/42",
      "/",
      "/__aio/health",
    ]
  ) {
    assertEquals(isShellAsset(p, false), true, `${p} must still be served`);
  }
  // …and an encoded path that IS a shell asset still resolves as one.
  assertEquals(isShellAsset("/style%2Ecss", false), true);
});

// A dotfile is deliberately NOT this gate's job: `isProtectedPath` denies it
// by name, on the decoded path, before the shell question is asked — and it
// must stay that way, because `/.well-known/...` is a legitimate anonymous
// fetch on a public app. Pinned here so the division of labour is explicit.
Deno.test("anon gate: a dotfile is denied by the protected-path rule, encoded or not", () => {
  assertEquals(isProtectedPath("/.env", false), true);
  assertEquals(isProtectedPath("/%2Eenv", false), true, "encoded too");
  assertEquals(isProtectedPath("/data/%2Egit/config", false), true);
});

Deno.test("anon gate: a path that cannot be decoded fails CLOSED", () => {
  // A malformed escape is not a file name, and must not be waved through as a
  // client route either.
  assertEquals(isShellAsset("/data/app%2", false), false);
  assertEquals(isShellAsset("/data/%ZZ", false), false);
});

Deno.test("protected paths: the rule does not depend on capitalisation", () => {
  for (
    const p of [
      "/secrets.server.ts",
      "/secrets.server.TS",
      "/secrets.Server.ts",
      "/secrets.SERVER.TS",
      "/api/db.server.js",
      "/api/db.Server.JS",
    ]
  ) {
    assertEquals(
      isProtectedPath(p, false),
      true,
      `${p} is a server-only file whatever its capitalisation`,
    );
  }
  // The prod TypeScript denial, same axis.
  for (const p of ["/App.tsx", "/App.TSX", "/main.TS"]) {
    assertEquals(isProtectedPath(p, true), true, `${p} in prod`);
  }
  // …and an ordinary asset is still not protected.
  assertEquals(isProtectedPath("/style.css", true), false);
  assert(!isProtectedPath("/app.js", true));
});

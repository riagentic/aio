// What a path that is NOT a servable file answers — and who may read one that is.
//
// Four holes in one decision, measured before the fix:
//
//  • `auth: true`, no credential: `GET /uploads/3f9a2c` → 200 and the upload's
//    bytes, `GET /LICENSE` → 200. The anonymous gate waves every extensionless
//    name through as "a client route", and the file layer then served the
//    FILE that existed there. The same paths on a `users:` app answer 401.
//  • A client route that shares a name with a project folder 404'd on reload
//    (`/docs`, `/settings/`), and so did a dotted last segment that names no
//    file (`/u/john.doe`, `/blog/v1.2`) — dev and prod alike, while
//    docs/ui/air-routing.md says "Deep links just work".
//  • Prod with no `dist/app.js`: `/` → the honest 503, every deep link → a 200
//    shell that 404s its own bundle.
//  • `b.SVG` / `f.CSS` → `application/octet-stream` + `nosniff`: the MIME and
//    text lookups were case-sensitive while the anonymous gate lower-cased.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import {
  _isRouteShaped,
  _isShellFile,
  blobContentType,
  createStaticHandler,
  fileExt,
  isShellAsset,
  type StaticDeps,
} from "../src/server/server-static.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: false,
    debug: () => {},
    title: "T",
    absBaseDir: "/nonexistent",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
    ...over,
  };
}

/** A project dir with folders that share names with client routes. */
async function project(): Promise<string> {
  const base = await Deno.makeTempDir({ prefix: "aio-shell-names-" });
  for (
    const d of ["docs", "settings", "uploads", ".well-known/acme-challenge"]
  ) {
    await Deno.mkdir(join(base, d), { recursive: true });
  }
  await Deno.writeTextFile(join(base, "docs", "x.tsx"), "export const x = 1");
  await Deno.writeTextFile(join(base, "uploads", "3f9a2c"), "PRIVATE-UPLOAD");
  await Deno.writeTextFile(join(base, "LICENSE"), "LICENSE-TEXT");
  await Deno.writeTextFile(join(base, "notes.md"), "NOTES");
  await Deno.writeTextFile(join(base, "logo.png"), "PNG");
  await Deno.writeTextFile(
    join(base, ".well-known", "acme-challenge", "tok123"),
    "ACME-TOKEN",
  );
  for (const f of ["b.SVG", "f.CSS", "d.JPG", "i.Png", "t.TXT"]) {
    await Deno.writeTextFile(join(base, f), "x");
  }
  return base;
}

const isShell = (body: string) => body.includes("<html");

// ── the rules, pure ──────────────────────────────────────────────────

Deno.test("fileExt: one lower-cased definition", () => {
  assertEquals(fileExt("b.SVG"), ".svg");
  assertEquals(fileExt("/x/Logo.PnG"), ".png");
  assertEquals(fileExt("LICENSE"), "");
  assertEquals(fileExt(".env"), "");
  assertEquals(blobContentType("CAT.PNG"), "image/png");
});

Deno.test("_isShellFile: an extensionless FILE is never shell; the gate still passes the route", () => {
  for (const f of ["3f9a2c", "LICENSE", "Makefile"]) {
    assertEquals(_isShellFile(f, false), false, f);
    assertEquals(_isShellFile(f, true), false, `${f} (dev)`);
  }
  for (const f of ["app.js", "STYLE.CSS", "robots.txt", "favicon.ico"]) {
    assertEquals(_isShellFile(f, false), true, f);
  }
  // The NAME-level gate cannot see the filesystem and must keep answering
  // "client route" for these — the file layer is the half that refuses.
  assertEquals(isShellAsset("/uploads/3f9a2c", false), true);
  assertEquals(isShellAsset("/u/john.doe", false), false, "fail closed");
});

Deno.test("_isRouteShaped: a directory or a non-file extension is a route; a missing asset is not", () => {
  assertEquals(_isRouteShaped("", "directory"), true);
  assertEquals(_isRouteShaped(".js", "directory"), true);
  for (const e of ["", ".doe", ".2", ".com"]) {
    assertEquals(_isRouteShaped(e, "missing"), true, e);
  }
  for (const e of [".js", ".css", ".png", ".ts", ".csv", ".md", ".map"]) {
    assertEquals(_isRouteShaped(e, "missing"), false, e);
  }
});

// ── the file layer ───────────────────────────────────────────────────

for (const prod of [false, true]) {
  Deno.test(`static (${prod ? "prod" : "dev"}): folder-named and dotted client routes get the shell; missing assets 404`, async () => {
    const base = await project();
    const dist = await Deno.makeTempDir({ prefix: "aio-shell-dist-" });
    try {
      await Deno.writeTextFile(join(dist, "app.js"), "// bundle");
      const { serveStatic } = createStaticHandler(
        deps({ prod, absBaseDir: base, absDistDir: prod ? dist : null }),
      );
      for (
        const p of [
          "/docs",
          "/docs/",
          "/settings",
          "/settings/",
          "/u/john.doe",
          "/blog/v1.2",
          "/sites/example.com",
          "/some/route",
        ]
      ) {
        const r = await serveStatic(p);
        const t = await r.text();
        assertEquals(r.status, 200, p);
        assert(isShell(t), `${p} → ${t.slice(0, 60)}`);
      }
      for (const p of ["/missing.js", "/missing.css", "/export.csv"]) {
        const r = await serveStatic(p);
        await r.body?.cancel();
        assertEquals(r.status, 404, p);
      }
      // An existing file still wins over the route reading of its name.
      const lic = await serveStatic("/LICENSE");
      assertEquals(await lic.text(), "LICENSE-TEXT");
      // Traversal and trailing-slash-on-a-file stay refused.
      for (
        const p of [
          "/%2e%2e/etc/passwd",
          "/docs/%2e%2e/%2e%2e/etc/passwd",
          "/docs/..%2f..%2fetc",
          "/docs/..%5c..%5cetc",
          "/LICENSE/",
        ]
      ) {
        const r = await serveStatic(p);
        const t = await r.text();
        assert(r.status === 404 || r.status === 403, `${p} → ${r.status}`);
        assert(!isShell(t), p);
      }
    } finally {
      await Deno.remove(base, { recursive: true });
      await Deno.remove(dist, { recursive: true });
    }
  });
}

Deno.test("static (prod): no dist/app.js → a deep link gets the same 503 as /", async () => {
  const dist = await Deno.makeTempDir({ prefix: "aio-shell-headless-" });
  try {
    const { serveStatic } = createStaticHandler(
      deps({ prod: true, absDistDir: dist }),
    );
    for (const p of ["/", "/some/deep/link", "/u/john.doe"]) {
      const r = await serveStatic(p);
      const t = await r.text();
      assertEquals(r.status, 503, p);
      assert(t.includes("Headless build"), p);
    }
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

for (const prod of [false, true]) {
  Deno.test(`static (${prod ? "prod" : "dev"}): upper-case extensions get their real Content-Type`, async () => {
    const base = await project();
    try {
      const { serveStatic } = createStaticHandler(
        deps({ prod, absBaseDir: base }),
      );
      for (
        const [p, want] of [
          ["/b.SVG", "image/svg+xml"],
          ["/f.CSS", "text/css"],
          ["/d.JPG", "image/jpeg"],
          ["/i.Png", "image/png"],
          ["/t.TXT", "text/plain"],
        ] as const
      ) {
        const r = await serveStatic(p);
        await r.body?.cancel();
        assertEquals(r.status, 200, p);
        assertEquals(r.headers.get("content-type"), want, p);
      }
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  });
}

// ── over HTTP, per-user auth ─────────────────────────────────────────

Deno.test("auth: true — an anonymous caller gets the SHELL for an extensionless name, never the file", async () => {
  _resetAuthFails();
  const base = await project();
  try {
    await using srv = await testServer({
      cells: [cell("anon_extless", { state: { n: 0 }, methods: {} })],
      baseDir: base,
      auth: true,
    });
    for (
      const [p, secret] of [
        ["/uploads/3f9a2c", "PRIVATE-UPLOAD"],
        ["/LICENSE", "LICENSE-TEXT"],
      ] as const
    ) {
      const r = await srv.fetch(p);
      const t = await r.text();
      assertEquals(r.status, 401, p);
      assertEquals(t.includes(secret), false, `${p} leaked its bytes`);
    }
    // …encoded and case variants of the same file too.
    for (const p of ["/uploads/3f9a2%63", "/%4CICENSE"]) {
      const r = await srv.fetch(p);
      const t = await r.text();
      assertEquals(r.status, 401, p);
      assert(!t.includes("PRIVATE-UPLOAD") && !t.includes("LICENSE-TEXT"), p);
    }
    // The controls: routes, folder-named routes and the public files.
    for (const p of ["/", "/some/route", "/uploads", "/docs/"]) {
      const r = await srv.fetch(p);
      const t = await r.text();
      assertEquals(r.status, 200, p);
      assert(isShell(t), p);
    }
    for (
      const [p, want] of [
        ["/logo.png", "PNG"],
        ["/.well-known/acme-challenge/tok123", "ACME-TOKEN"],
      ] as const
    ) {
      const r = await srv.fetch(p);
      assertEquals(r.status, 200, p);
      assertEquals(await r.text(), want, p);
    }
    const md = await srv.fetch("/notes.md");
    await md.body?.cancel();
    assertEquals(md.status, 401);
  } finally {
    _resetAuthFails();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("users: — the same paths stay 401 anonymously and readable with a token", async () => {
  _resetAuthFails();
  const base = await project();
  try {
    await using srv = await testServer({
      cells: [cell("users_extless", { state: { n: 0 }, methods: {} })],
      baseDir: base,
      users: { tok_extless: { id: "u1", name: "U", role: "user" } },
    });
    for (const p of ["/uploads/3f9a2c", "/LICENSE", "/docs"]) {
      const r = await srv.fetch(p);
      await r.body?.cancel();
      assertEquals(r.status, 401, p);
    }
    const auth = { headers: { Authorization: "Bearer tok_extless" } };
    const up = await srv.fetch("/uploads/3f9a2c", auth);
    assertEquals(await up.text(), "PRIVATE-UPLOAD");
    const docs = await srv.fetch("/docs", auth);
    assert(isShell(await docs.text()), "a signed-in reload of /docs");
  } finally {
    _resetAuthFails();
    await Deno.remove(base, { recursive: true });
  }
});

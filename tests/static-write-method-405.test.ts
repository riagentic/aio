// A write method that matches no route is a 405, not the file or the shell.
//
// Static serving and the SPA fallback answered EVERY method: `POST /api/uplaod`
// (a typo'd route) got `200 text/html` — the app shell — so `res.ok` was true
// and the app told its user the upload worked. `DELETE /notes.txt` answered
// 200 with the file, as if it had been deleted. The framework's own endpoints
// already refuse a method they do not serve (`AIO_ROUTE_METHODS`); the files
// and the shell under them did not.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const c = cell("static-write-method-405", { state: { n: 0 } });

Deno.test("static: POST/PUT/DELETE to a file or a client route is 405, GET/HEAD unchanged", async () => {
  const dir = await tempDir("aio-static-405-");
  try {
    await Deno.writeTextFile(join(dir, "notes.txt"), "hello");
    await using srv = await testServer({
      cells: [c],
      baseDir: dir,
      routes: {
        "/api/upload": (req) => new Response(`routed ${req.method}`),
      },
    });
    const paths = ["/", "/notes.txt", "/api/uplaod", "/some/client/route"];
    const writes = ["POST", "PUT", "DELETE", "PATCH"];
    assertEquals(paths.length * writes.length, 16);
    for (const p of paths) {
      for (const method of writes) {
        const res = await srv.fetch(p, { method, body: "x" });
        await res.text();
        assertEquals(res.status, 405, `${method} ${p}`);
        assertEquals(res.headers.get("allow"), "GET, HEAD", `${method} ${p}`);
      }
      for (const method of ["GET", "HEAD"]) {
        const res = await srv.fetch(p, { method });
        await res.text();
        assertEquals(res.status, 200, `${method} ${p}`);
      }
    }
    // A declared route still answers every method itself.
    const routed = await srv.fetch("/api/upload", {
      method: "POST",
      body: "x",
    });
    assertStringIncludes(await routed.text(), "routed POST");
    // The framework namespace keeps its own answers (404 for what is not there).
    const miss = await srv.fetch("/__aio/nope", { method: "POST" });
    await miss.text();
    assertEquals(miss.status, 404);
  } finally {
    await dropTempDir(dir);
  }
});

// …but a browser NAVIGATION that POSTs to a page is not a typo'd fetch. A
// payment provider's return URL, a SAML/OIDC `form_post`, a `<form
// method=post>` submitted before hydration all land the USER on a page, and
// 1.0.11 answered them with the shell. A 405 text page there strands a real
// person mid-checkout — the frozen surface keeps the shell and warns.
Deno.test("static: a POST navigation to a client route still gets the shell (1.0.11), a fetch POST stays 405", async () => {
  const dir = await tempDir("aio-static-405-nav-");
  try {
    await using srv = await testServer({ cells: [c], baseDir: dir });
    const nav = await srv.fetch("/checkout/done", {
      method: "POST",
      body: "status=paid",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    assertEquals(nav.status, 200);
    assertStringIncludes(await nav.text(), "<html");
    const api = await srv.fetch("/checkout/done", {
      method: "POST",
      body: "x",
      headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    });
    await api.text();
    assertEquals(api.status, 405);
  } finally {
    await dropTempDir(dir);
  }
});

// Fetch metadata is not on every navigation: Chromium sends `Sec-Fetch-*` only
// to a potentially trustworthy origin, so a form POST from a page on a LAN
// address over plain http (`--expose` without TLS, the remote APK) carries
// none — nor does Safari before 16.4. That navigation still says what it is
// in `Accept: text/html`; 1.0.11 gave it the shell, and it keeps it. A fetch
// with no metadata (`Accept: */*`) is still the typo'd-upload case: 405.
Deno.test("static: a POST navigation WITHOUT fetch metadata (plain-http LAN origin, older Safari) still gets the shell", async () => {
  const dir = await tempDir("aio-static-405-nometa-");
  try {
    await using srv = await testServer({ cells: [c], baseDir: dir });
    const nav = await srv.fetch("/checkout/done", {
      method: "POST",
      body: "status=paid",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    assertEquals(nav.status, 200);
    assertStringIncludes(await nav.text(), "<html");
    const api = await srv.fetch("/checkout/done", {
      method: "POST",
      body: "x",
      headers: { accept: "*/*" },
    });
    await api.text();
    assertEquals(api.status, 405);
  } finally {
    await dropTempDir(dir);
  }
});

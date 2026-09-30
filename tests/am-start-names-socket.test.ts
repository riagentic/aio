// `am start` of a SOCKET-ONLY app (the desktop shape: a unix socket, no TCP
// port) printed `started sockapp (pid …, port 0)` — a door that does not
// exist. It names the socket now, as `am status` does. A TCP app also names
// the URL to click: the port alone left the reader typing it by hand.
import { assertEquals } from "@std/assert";
import {
  localAppUrl,
  servesTls,
  startedReport,
} from "../src/am/am-cmd-process.ts";

Deno.test("startedReport: a socket-only app is named by its socket, never 'port 0'", () => {
  const s = startedReport("sockapp", 42, 0, "/run/aio/sockapp.sock");
  assertEquals(
    s.line,
    "started sockapp (pid 42, socket /run/aio/sockapp.sock)",
  );
  assertEquals(s.doc, {
    appId: "sockapp",
    pid: 42,
    port: 0,
    status: "started",
    transport: "uds",
    socketPath: "/run/aio/sockapp.sock",
  });
  // A TCP app: the port AND the URL a person can click.
  const t = startedReport("web", 7, 8123);
  assertEquals(t.line, "started web (pid 7, port 8123, http://localhost:8123)");
  assertEquals(t.doc, {
    appId: "web",
    pid: 7,
    port: 8123,
    status: "started",
    url: "http://localhost:8123",
  });
  // Both doors: the port, the socket beside it, and the URL.
  assertEquals(
    startedReport("both", 7, 8123, "/s").line,
    "started both (pid 7, port 8123, transport uds (/s), http://localhost:8123)",
  );
});

// An app serving TLS answers only on https — the URL's scheme has to follow,
// or clicking it lands on a refused plain-HTTP port.
Deno.test("startedReport: a TLS app names an https URL", () => {
  const t = startedReport("tls", 7, 8443, undefined, undefined, true);
  assertEquals(
    t.line,
    "started tls (pid 7, port 8443, https://localhost:8443)",
  );
  assertEquals(t.doc.url, "https://localhost:8443");
});

Deno.test("localAppUrl / servesTls: the URL only exists for a bound port, the scheme follows TLS", () => {
  assertEquals(localAppUrl(8123), "http://localhost:8123");
  assertEquals(localAppUrl(8443, true), "https://localhost:8443");
  assertEquals(localAppUrl(0), undefined); // socket-only: no URL
  assertEquals(servesTls({ trojanPort: 9090 }), true);
  assertEquals(servesTls({ discovery: { tls: true } }), true);
  assertEquals(servesTls({ discovery: { tls: false } }), false);
  assertEquals(servesTls(undefined), false);
});

// A field report scripted screenshots over raw CDP and hunted the port with
// `ss` — `am shot` existed. A `--cdp` start names the verb at the moment it is
// needed.
Deno.test("startedReport: a --cdp start names am shot", () => {
  const c = startedReport("desk", 7, 8123, undefined, 9333);
  assertEquals(
    c.line,
    "started desk (pid 7, port 8123, http://localhost:8123)\n" +
      "cdp 127.0.0.1:9333 — screenshots: am shot (not raw CDP)",
  );
  assertEquals(c.doc, startedReport("desk", 7, 8123).doc);
});

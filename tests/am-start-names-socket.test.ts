// `am start` of a SOCKET-ONLY app (the desktop shape: a unix socket, no TCP
// port) printed `started sockapp (pid …, port 0)` — a door that does not
// exist. It names the socket now, as `am status` does.
import { assertEquals } from "@std/assert";
import { startedReport } from "../src/am/am-cmd-process.ts";

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
  // A TCP app: unchanged.
  const t = startedReport("web", 7, 8123);
  assertEquals(t.line, "started web (pid 7, port 8123)");
  assertEquals(t.doc, { appId: "web", pid: 7, port: 8123, status: "started" });
  // Both doors: the port, and the socket beside it.
  assertEquals(
    startedReport("both", 7, 8123, "/s").line,
    "started both (pid 7, port 8123, transport uds (/s))",
  );
});

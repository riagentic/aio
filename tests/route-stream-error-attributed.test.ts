// A route whose STREAMED body errors before it is sent is a 500 the app's own
// log names — method and path — not a bare `Error: …` from `Deno.serve`.
//
// The response finisher reads a compressible body to compress it; a stream
// that errors meanwhile (a DB cursor dying mid-response) threw out of the
// request handler into Deno's default error handler, which printed the bare
// message to stderr: no route, no path, no app, nothing in error.log.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("a route body that errors mid-read: 500, and an error line naming the path", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    await using srv = await testServer({
      cells: [cell("stream_err", { state: { n: 0 }, methods: {} })],
      routes: {
        "/rows": () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("[".padEnd(2000, " ")));
                c.error(new Error("cursor died"));
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      },
    });
    const r = await srv.fetch("/rows");
    await r.body?.cancel();
    assertEquals(r.status, 500);
    assertEquals(r.headers.get("x-content-type-options"), "nosniff");
    assert(
      lines.some((l) => l.includes("GET /rows") && l.includes("cursor died")),
      `no attributed error line: ${JSON.stringify(lines)}`,
    );
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
});

// A problem report's log tail never carries the app's credentials.
//
// At `--expose` boot aio writes the share link — `share: http://…/?token=<the
// app key>` — and the one-shot pair code into app.log, on purpose, for the
// operator. The report tails app.log (the last 200 lines: on a quiet app the
// boot banner is in them) and POSTs the report to the feedback URL, so the key
// that is "the only thing in front of" the exposed app left the machine in a
// bug report. `redactUrlToken`'s own doc names the case — "logs are copied
// into bug reports" — and the report was the one copier that did not call it.
import { assert, assertEquals } from "@std/assert";
import { buildReport } from "../src/server/report.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const KEY = "5b0e3c7a-TOPSECRET-app-key";
const PIN = "402917";

Deno.test("report logs: the share-link token and the pair code are masked", async () => {
  const dir = await tempDir("aio-report-logtail-");
  try {
    const lines = [
      `2026-09-25T10:00:00Z INFO share: http://192.168.1.4:8000/?token=${KEY}`,
      `2026-09-25T10:00:00Z INFO share (ann/admin): http://h:1/?a=1&token=${KEY} (lan)`,
      `2026-09-25T10:00:00Z INFO pair code: ${PIN}  (enter it in the aio client → Add app)`,
      `2026-09-25T10:00:01Z INFO order 402917 shipped`,
    ];
    await Deno.writeTextFile(`${dir}/app.log`, lines.join("\n") + "\n");
    const r = await buildReport({
      kind: "error",
      title: `net: connect to http://h:1/?token=${KEY} failed`,
    }, {
      appId: "a",
      appVersion: "1",
      aioVersion: "1",
      dataDir: dir,
      logsDir: dir,
      exposed: true,
      persist: false,
      cells: [],
    });
    assertEquals(r.logs?.length, 4, JSON.stringify(r.logs));
    const text = JSON.stringify(r);
    assert(!text.includes(KEY), "the app key left in the report");
    assertEquals(r.title, "net: connect to http://h:1/?token=… failed");
    assert(!r.logs![2]!.includes(PIN), "the pair code left: " + r.logs![2]);
    assert(r.logs![0]!.includes("share: http://192.168.1.4:8000/?token="));
    assert(r.logs![3]!.includes("order 402917 shipped"), "other lines kept");
  } finally {
    await dropTempDir(dir);
  }
});

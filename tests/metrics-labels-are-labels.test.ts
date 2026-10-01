// A Prometheus label must name a dimension, not an identity.
//
// `aio_broadcast_bytes_total{kind="…"}` and its message twin carried
// `meta.id` — a per-CONNECTION uuid — in a label called `kind`, with HELP text
// saying "per kind". Three defects in one line: the name and the help
// described something the series did not contain; every reconnect (the dev
// reload socket retries every 2 s) minted a brand-new series, so a scraped
// endpoint grew its time-series cardinality without bound; and the counter was
// unusable regardless, because a series vanishes when its client disconnects.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { formatPrometheus } from "../src/server/server-metrics.ts";

Deno.test("metrics: the broadcast counters are unlabelled server totals", () => {
  const text = formatPrometheus({
    uptimeSeconds: 1,
    clients: 2,
    payloads: new Map([
      // Two CONNECTIONS, which is what this map is keyed by.
      ["3f1a-uuid-one", { lastPayloadBytes: 10, totalBytes: 100, count: 4 }],
      ["9c2b-uuid-two", { lastPayloadBytes: 20, totalBytes: 250, count: 6 }],
    ]),
  });

  // Summed, once, with no label.
  assertMatch(text, /^aio_broadcast_bytes_total 350$/m);
  assertMatch(text, /^aio_broadcast_messages_total 10$/m);

  // No connection id may appear anywhere in the output.
  assert(!text.includes("3f1a-uuid-one"), text);
  assert(!text.includes("9c2b-uuid-two"), text);
  // …and specifically not as a `kind`.
  assertEquals(
    text.split("\n").filter((l) =>
      l.startsWith("aio_broadcast") && l.includes("kind=")
    ),
    [],
  );
});

Deno.test("metrics: a label that IS a dimension is still emitted", () => {
  // The instrument check: this asserts the absence of labels above, so it has
  // to show that labels are not simply gone.
  const text = formatPrometheus({
    uptimeSeconds: 1,
    clients: 0,
    cells: { cart: { errors: 2, enabled: true } },
  });
  assertMatch(text, /^aio_cell_errors_total\{cell="cart"\} 2$/m);
});

Deno.test("metrics: native memory and the named ledger series are scraped", () => {
  // The native half (`external`) and the ledger gauges are what let a scrape
  // say WHICH subsystem grew — the two numbers a heap-only endpoint never had.
  const text = formatPrometheus({
    uptimeSeconds: 1,
    memory: { rss: 500, heapTotal: 400, heapUsed: 300, external: 42 },
    gauges: [
      {
        name: "broadcast.bufferedBytes",
        owner: "broadcast",
        unit: "bytes",
        kind: "level",
        value: 111_940_000,
      },
      {
        name: "journal.replay.entries",
        owner: "journal",
        unit: "count",
        kind: "counter",
        value: 7,
        bound: 2_000_000,
      },
    ],
  });
  assertMatch(text, /^aio_memory_external_bytes 42$/m);
  assertMatch(
    text,
    /^aio_memory_gauge\{name="broadcast\.bufferedBytes",owner="broadcast",unit="bytes",kind="level"\} 111940000$/m,
  );
  // The counter carries its ceiling, so a scrape shows how close it is.
  assertMatch(
    text,
    /^aio_memory_gauge_limit\{name="journal\.replay\.entries"\} 2000000$/m,
  );
});

// `visible` gates READS. `access` gates CALLS. Neither implies the other.
//
// An audit of an app that holds keys found what happens when one key is read
// as doing both jobs: a cell with `visible: "none"` still has every method
// callable by any connected client, and the return value travels back. The app
// shipped a PBKDF2 `encrypt`/`decrypt` cell that way — a decryption oracle and
// an unmetered passphrase oracle behind a public door — next to a carefully
// maintained `visible.exclude` list that existed to prevent exactly that.
//
// So the combination "this cell hides something that looks like a secret, and
// nothing says who may CALL it" is said out loud at boot. It is a notice, not a
// refusal: apps boot with that shape today, and "everyone may call, nobody may
// read" is a legitimate design — it just has to be the one that was meant.
//
// The heuristic must not cry wolf, which is the whole reason it reads NAMES: a
// cell that hides scratch state and has no secret-shaped name never trips it.
import { assert, assertEquals } from "@std/assert";
import { captureConsole } from "./console-capture.ts";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type AnyEntry = Parameters<typeof composeCellsWiring>[0]["cellEntries"];

/** The notices this file is about — `visibility` warnings that name the calls. */
function noticesFor(entries: AnyEntry): string[] {
  setLogger(null); // force the console fallback so it can be captured
  const out = captureConsole(() => {
    composeCellsWiring({ cellEntries: entries });
  });
  return out.filter((l) =>
    l.includes("WARN") && l.includes("visibility") && l.includes("callable")
  );
}

Deno.test('hidden cell: `visible: "none"` + no `access` is said out loud', () => {
  const heavy = cell("heavy", {
    state: { busy: false },
    visible: "none", // reads: nothing. calls: everything, still.
    methods: {
      encrypt(_s, _plain: string) {
        return "cipher";
      },
      decrypt(_s, _cipher: string) {
        return "plain";
      },
    },
  });
  const n = noticesFor([heavy]);
  assertEquals(n.length, 1, `expected one notice; got: ${n.join(" | ")}`);
  const line = n[0]!;
  assert(line.includes("[heavy]"), line); // names the cell
  assert(line.includes("encrypt") && line.includes("decrypt"), line); // …and what is callable
  assert(line.includes("access"), line); // …and the fix
  assert(line.includes("visible"), line);
});

Deno.test("hidden cell: a non-empty `visible.exclude` of a secret counts too", () => {
  const seeds = cell("seeds", {
    state: { rows: [] as { id: string; encSeed: string }[] },
    visible: { exclude: ["rows.encSeed"] }, // the ciphertext never broadcasts…
    methods: {
      // …and this hands it to whoever asks.
      seedOf(s, id: string) {
        return s.rows.find((r) => r.id === id)?.encSeed;
      },
    },
  });
  const n = noticesFor([seeds]);
  assertEquals(n.length, 1, `expected one notice; got: ${n.join(" | ")}`);
  assert(n[0]!.includes("[seeds]"), n[0]!);
  assert(n[0]!.includes("seedOf"), n[0]!);
});

Deno.test("hidden cell: declaring `access` answers it — no notice", () => {
  const mk = (access: false | (() => boolean)) =>
    cell(`heavy_${typeof access}`, {
      state: { busy: false },
      visible: "none",
      access,
      methods: {
        encrypt(_s, _plain: string) {
          return "cipher";
        },
      },
    });
  assertEquals(noticesFor([mk(false)]), []);
  assertEquals(noticesFor([mk(() => true)]), []);
});

Deno.test("hidden cell: no secret-shaped name anywhere → never fires", () => {
  // The scratch-state pattern the docs recommend, and a background worker with
  // `visible: "none"`. Neither holds a secret; neither may be nagged.
  const net = cell("net", {
    state: { rxMbps: 0, prevBytes: 0 },
    visible: { exclude: ["prevBytes"] },
    methods: {
      tick(s, bytes: number) {
        s.rxMbps = (bytes - s.prevBytes) / 1e6;
        s.prevBytes = bytes;
      },
    },
  });
  const worker = cell("queue", {
    state: { queue: [] as string[], lastSync: 0 },
    visible: "none",
    methods: {
      push(s, item: string) {
        s.queue.push(item);
      },
    },
  });
  assertEquals(noticesFor([net]), []);
  assertEquals(noticesFor([worker]), []);
});

Deno.test("hidden cell: nothing callable → nothing to say", () => {
  const vault = cell("vault", {
    state: { passphrase: "" },
    visible: "none",
    methods: {}, // no method: no door
  });
  assertEquals(noticesFor([vault]), []);
});

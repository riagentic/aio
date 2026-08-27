# Cassettes — record once, replay forever

Some async calls cannot be made in CI. A hardware wallet is not plugged into the
build box, a price feed answers differently every minute, a vendor sandbox is
down on Fridays. The usual answer is a hand-written mock, which drifts from the
real thing silently and passes anyway.

A cassette is the other answer: wrap the real async function, run it **once**
against the real device or endpoint, and keep what came back. Every run after
that serves the recording — no device, no network, deterministic, and the
fixture was produced by the real thing rather than by someone's memory of it.

```ts
import { assertEquals } from "@std/assert";
import { openCassette } from "aio/testing";

// The call you cannot make in CI.
async function fetchRate(pair: string): Promise<number> {
  const res = await fetch(`https://rates.example.com/${pair}`);
  const body = await res.json() as { rate: number };
  return body.rate;
}

Deno.test("quotes use the live rate", async () => {
  // File absent → record mode (calls through, captures). Present → replay.
  const tape = await openCassette("./tests/fixtures/rates.cassette.json");
  const rate = tape.wrap("rates.fetch", fetchRate);

  const usd = await rate("BTC-USD");
  assertEquals(usd > 0, true);

  await tape.save(); // writes the tape in record mode; a no-op in replay
});
```

Run it once with the network up: the fixture appears. Commit it. Every run after
that never touches `fetch`.

## The API

`aio/testing` exports two constructors and three types.

| Function                      | Signature                                                          |
| ----------------------------- | ------------------------------------------------------------------ |
| `openCassette(path, opts?)`   | `(string, { mode?: CassetteMode }) => Promise<Cassette>`           |
| `createCassette(mode, opts?)` | `(CassetteMode, { path?, initial? }) => Cassette` — no file access |

`openCassette` is the one an app uses. With no `mode` it decides from the file:
present and parseable → `"replay"`, absent or corrupt → `"record"`. Pass `mode`
to pin it (a CI job that must never record passes `{ mode: "replay" }`).

`createCassette` is the in-memory form — you hand it the frames yourself. Useful
when the tape does not come from a file (a fixture built in the test, a tape
fetched from somewhere else), and it is what `openCassette` calls.

A `Cassette` has five members:

| Member         | What it does                                                                          |
| -------------- | ------------------------------------------------------------------------------------- |
| `wrap(id, fn)` | Returns a same-signature function that records / replays / calls through              |
| `save()`       | `Promise<void>` — writes the recorded frames to `path`. No-op unless record + path    |
| `serialize()`  | `string` — the recorded frames as JSON, for a tape you store yourself                 |
| `mode`         | `CassetteMode`, readonly                                                              |
| `frames`       | `readonly CassetteFrame[]` — what was RECORDED this run (empty in replay/passthrough) |

## Modes

| Mode            | `wrap`ped call does                              |
| --------------- | ------------------------------------------------ |
| `"record"`      | calls the real function, captures the outcome    |
| `"replay"`      | never calls it — answers from the tape           |
| `"passthrough"` | calls it, records nothing (the tape is bypassed) |

`"passthrough"` is the escape hatch for "run this test against the real thing
today" without deleting the fixture.

## How a call is matched

A frame is keyed by three things, in this order:

1. `id` — the string you passed to `wrap()`, e.g. `"trezor.getPublicKey"`.
2. `key` — `JSON.stringify(args)`. Different arguments are different frames.
3. `seq` — a per-`id`+`key` counter, so **repeat calls with the same arguments
   replay in the order they were recorded**.

That third one is what makes a nonce, a counter or a paginated feed replayable:

```ts
import { assertEquals } from "@std/assert";
import { createCassette } from "aio/testing";

Deno.test("repeat calls come back in recorded order", async () => {
  let n = 0;
  const rec = createCassette("record");
  const next = rec.wrap("counter.next", () => Promise.resolve(++n));
  await next();
  await next();
  await next();

  const play = createCassette("replay", {
    initial: JSON.parse(rec.serialize()),
  });
  const replayed = play.wrap("counter.next", () => Promise.resolve(-1));
  assertEquals([await replayed(), await replayed(), await replayed()], [
    1,
    2,
    3,
  ]);
});
```

## A missing frame is loud

Replay does not fall back to calling the real function. If the call sequence
changed — a new argument, an extra call, a reordering — the wrapped function
throws, naming the id:

```
cassette: no recorded frame for "rates.fetch" with these args —
re-record the cassette (the call sequence changed).
```

That is deliberate. A cassette that silently called through would turn a CI
machine into a device-dependent one at the exact moment the recording stopped
describing the code, and the test would still be green. Delete the file and run
once with the real dependency to re-record.

## Errors record too

A rejection is captured as a frame with `ok: false` and replays as a throw, so
the unhappy path is as reproducible as the happy one:

```ts
import { assertRejects } from "@std/assert";
import { createCassette } from "aio/testing";

Deno.test("a recorded failure replays as a failure", async () => {
  const rec = createCassette("record");
  const flaky = rec.wrap("io.read", () => Promise.reject(new Error("busy")));
  await assertRejects(() => flaky(), Error, "busy");

  const play = createCassette("replay", {
    initial: JSON.parse(rec.serialize()),
  });
  const replayed = play.wrap("io.read", () => Promise.resolve("nope"));
  await assertRejects(() => replayed(), Error, "busy");
});
```

Only the **message** survives. A frame stores `error: string`, so replay throws
a plain `Error` with that message — assert on the message, not on a custom error
class.

## What a cassette can carry

Two contract lines, both enforced by physics rather than by a check:

- **Arguments must be JSON-serializable** — they are the match key. An
  unserializable argument (a class instance with cycles, a function) falls back
  to `String(args)`, which will not match on replay.
- **Results must survive a JSON round-trip.** A `Date` comes back as a string, a
  `Map` as `{}`, a `Uint8Array` as an object of indices. Wrap at a boundary that
  already speaks plain data — the transport call, not the decoded domain object.

The natural wrap point is therefore the lowest-level async function in the
adapter: `device.exchange(apdu)` rather than `wallet.signTransaction(tx)`.

## A `CassetteFrame`

The on-disk format is a plain JSON array, readable and editable:

```json
[
  {
    "id": "rates.fetch",
    "key": "[\"BTC-USD\"]",
    "seq": 0,
    "ok": true,
    "value": 64210.5
  }
]
```

`id`, `key`, `seq`, `ok`, and then either `value` (on success) or `error` (a
string, on failure). Nothing is compressed or encoded — a reviewer can see in a
diff exactly what a test now believes about the outside world, which is the
second reason cassettes beat mocks.

> Secrets: a recording contains whatever the real call returned. Record against
> a test account, and read the tape before committing it.

## Related

- [Cell Testing](cell-testing.md) — `testCell`, assertions, async, fuzz
- [UI Testing](ui-testing.md) — the semantic UI surface
- [Testing several apps](multi-app.md) — `testApps`, the service + rich-client
  shape

// WHY a transport may never park one blocking-pool thread per connection.
//
// Deno runs `nonblocking: true` FFI calls — and async fs ops — on ONE shared,
// CAPPED thread pool (32 on unix, 4×cores on Windows). `win-pipe.ts` used to
// park one `WaitForSingleObject` per pending pipe operation, and every open
// connection always has a pending read, so a page with enough connections
// took the pool. What froze the app was not slowness: past the cap, every
// further FFI call AND every async fs op queued behind waits that only queued
// work could release. A compiled app on Windows 11 stopped answering
// permanently at 58 unread `<img>` responses (field report §13).
//
// The Win32 half of the fix is proven under Wine (`scripts/wine-pipe.ts`) and
// on a real Windows VM. THIS pins the platform-independent half: the pool is
// shared and capped, so "one parked thread per connection" is a design that
// cannot be made to work — measured, in a child process, because FFI needs
// `--unstable-ffi`.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const LIB: Record<string, string> = {
  linux: "libc.so.6",
  darwin: "libSystem.B.dylib",
};

const PROBE = `
const lib = Deno.dlopen(Deno.args[0], {
  usleep: { parameters: ["u32"], result: "i32", nonblocking: true },
} as const).symbols;
const MS = 300;
const park = (n: number) =>
  Array.from({ length: n }, () => lib.usleep(MS * 1000));

const t0 = Date.now();
await Promise.all(park(8));
const eight = Date.now() - t0;

// More waits than the pool has threads: the last ones cannot start until the
// first ones give a thread back.
const t1 = Date.now();
const many = Promise.all(park(48));
// …and an async fs op, queued behind them — this is the part that takes the
// whole app down rather than one transport.
const t2 = Date.now();
const read = Deno.readTextFile(Deno.args[1]).then(() => Date.now() - t2);
const fs = await read;
await many;
const over = Date.now() - t1;
console.log(JSON.stringify({ eight, over, fs, ms: MS }));
`;

Deno.test({
  name:
    "the blocking pool is shared and capped — one parked thread per connection cannot work",
  ignore: !(Deno.build.os in LIB),
  async fn() {
    const dir = await tempDir("aio-pool");
    const probe = join(dir, "probe.ts");
    await Deno.writeTextFile(probe, PROBE);
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-ffi",
        probe,
        LIB[Deno.build.os]!,
        probe,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assert(
      out.success,
      `the pool probe failed: ${new TextDecoder().decode(out.stderr)}`,
    );
    const r = JSON.parse(text.trim().split("\n").pop()!) as {
      eight: number;
      over: number;
      fs: number;
      ms: number;
    };
    // 8 waits fit in one round — the pool is not the bottleneck there.
    assert(
      r.eight < r.ms * 1.8,
      `8 parallel waits took ${r.eight} ms (one wait is ${r.ms} ms)`,
    );
    // 48 do not. Lower bound only: load can make this longer, never shorter,
    // and an UNCAPPED pool is the only thing that could make it shorter.
    assert(
      r.over >= r.ms * 1.6,
      `48 parallel waits took ${r.over} ms — with a pool this size they ` +
        `would all have run at once, and the premise of win-pipe's completion ` +
        `port (a scarce, shared pool) would be wrong`,
    );
    // And the fs op that had nothing to do with any of it waited too. This is
    // why a transport exhausting the pool freezes the whole app — persistence
    // included — rather than just itself.
    assert(
      r.fs >= r.ms * 0.5,
      `an unrelated async fs op took ${r.fs} ms while the pool was full — ` +
        `expected it to queue behind the parked waits`,
    );
  },
});

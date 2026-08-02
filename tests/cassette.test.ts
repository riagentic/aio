// transport cassettes: record a real device/network session once,
// replay it forever in CI (no device, deterministic).
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type CassetteFrame,
  createCassette,
  openCassette,
} from "../src/state/cassette.ts";
import { join } from "@std/path";

Deno.test("cassette record → replay: replays without calling the real fn", async () => {
  // Record against a "device" whose real fn we can detect being called.
  let realCalls = 0;
  const rec = createCassette("record");
  const getKey = rec.wrap("hw.getKey", (path: string) => {
    realCalls++;
    return Promise.resolve(`key-for-${path}`);
  });
  assertEquals(await getKey("m/44"), "key-for-m/44");
  assertEquals(await getKey("m/45"), "key-for-m/45");
  assertEquals(realCalls, 2);

  // Replay from the recorded frames — the real fn must NOT run.
  const frames = JSON.parse(rec.serialize()) as CassetteFrame[];
  const play = createCassette("replay", { initial: frames });
  let replayReal = 0;
  const getKey2 = play.wrap("hw.getKey", (_p: string) => {
    replayReal++;
    return Promise.resolve("SHOULD-NOT-RUN");
  });
  assertEquals(await getKey2("m/44"), "key-for-m/44");
  assertEquals(await getKey2("m/45"), "key-for-m/45");
  assertEquals(replayReal, 0, "replay must not touch the real device");
});

Deno.test("cassette: repeat calls with same args replay in recorded order", async () => {
  let n = 0;
  const rec = createCassette("record");
  const next = rec.wrap("rng", () => Promise.resolve(++n));
  await next();
  await next();
  await next(); // records 1, 2, 3 under the same (id,key)
  const play = createCassette("replay", {
    initial: JSON.parse(rec.serialize()),
  });
  const p = play.wrap("rng", () => Promise.resolve(-1));
  assertEquals([await p(), await p(), await p()], [1, 2, 3]);
});

Deno.test("cassette: a recorded error replays as a throw", async () => {
  const rec = createCassette("record");
  const flaky = rec.wrap("io", () => Promise.reject(new Error("device busy")));
  await assertRejects(() => flaky(), Error, "device busy");
  const play = createCassette("replay", {
    initial: JSON.parse(rec.serialize()),
  });
  const f = play.wrap("io", () => Promise.resolve("nope"));
  await assertRejects(() => f(), Error, "device busy");
});

Deno.test("cassette: replay with no matching frame fails loudly", async () => {
  const play = createCassette("replay", { initial: [] });
  const f = play.wrap("io", () => Promise.resolve(1));
  await assertRejects(() => f(), Error, "no recorded frame");
});

Deno.test("openCassette: absent file records, present file replays", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "hw.cassette.json");
    // First run: file absent → record mode → save.
    const rec = await openCassette(path);
    assertEquals(rec.mode, "record");
    const call = rec.wrap(
      "hw.sign",
      (m: string) => Promise.resolve(`sig(${m})`),
    );
    assertEquals(await call("tx1"), "sig(tx1)");
    await rec.save();

    // Second run: file present → replay mode, no real call.
    const play = await openCassette(path);
    assertEquals(play.mode, "replay");
    const call2 = play.wrap("hw.sign", (_m: string) => Promise.resolve("REAL"));
    assertEquals(await call2("tx1"), "sig(tx1)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// deno.json `build.channel` had three readers: `aio ship` (non-string →
// "prod"), `am publish` (the raw value — `5` wrote into `<dir>/5/`, `""` into
// the dir's root) and the running app (the raw value as its update stamp).
// One decider now, `buildChannel`, and every reader goes through it.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildChannel } from "../src/server/updates-core.ts";

Deno.test("buildChannel: a channel name is the channel; anything else is no stamp", () => {
  assertEquals(buildChannel({ channel: "test" }), "test");
  assertEquals(buildChannel({ channel: "prod" }), "prod");
  for (const b of [undefined, null, {}, { channel: 5 }, { channel: "" }]) {
    assertEquals(buildChannel(b), undefined, JSON.stringify(b));
  }
});

Deno.test("build.channel: ship, am publish and the app all read it through buildChannel", async () => {
  const read = (rel: string) =>
    Deno.readTextFile(fromFileUrl(new URL(rel, import.meta.url)));
  for (
    const [rel, call] of [
      ["../src/build/ship.ts", "buildChannel(buildCfg)"],
      ["../src/am/am-cmd-publish.ts", "buildChannel(cfg.build)"],
      ["../src/server/aio.ts", "buildChannel(appDenoJson()?.build)"],
    ]
  ) {
    const src = await read(rel!);
    assert(src.includes(call!), `${rel} reads build.channel itself`);
    // …and no second, private reading beside it.
    assert(!/(\.build\??|buildCfg)\.channel\b/.test(src), rel);
  }
});

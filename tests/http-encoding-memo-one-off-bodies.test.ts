// The compressed-body memo must hold what is asked for AGAIN. An untagged body
// is keyed by its own hash, so one-off JSON replies each took a fresh entry
// until the 32 MB bound — a long-running server pinned 32 MB of dead bodies
// and evicted the tagged bundle (measured in a soak: external memory 1.5 →
// 37 MB within a minute of API traffic).
import { assertEquals } from "@std/assert";
import {
  _clearEncodedCache,
  _encodedCacheSize,
  encodeResponse,
} from "../src/server/http-encoding.ts";

const req = () =>
  new Request("http://x/api", { headers: { "accept-encoding": "gzip" } });
const json = (body: string, etag?: string) =>
  new Response(body, {
    headers: {
      "content-type": "application/json",
      ...(etag ? { etag } : {}),
    },
  });
const body = (i: number) => JSON.stringify({ i, pad: "x".repeat(2000) });

Deno.test("encoding memo: distinct untagged bodies take no entries", async () => {
  _clearEncodedCache();
  for (let i = 0; i < 200; i++) {
    await (await encodeResponse(req(), json(body(i)))).arrayBuffer();
  }
  assertEquals(_encodedCacheSize(), 0);
});

Deno.test("encoding memo: a repeated untagged body and a tagged one are kept", async () => {
  _clearEncodedCache();
  await (await encodeResponse(req(), json(body(1)))).arrayBuffer();
  assertEquals(_encodedCacheSize(), 0);
  await (await encodeResponse(req(), json(body(1)))).arrayBuffer();
  assertEquals(_encodedCacheSize(), 1);
  await (await encodeResponse(req(), json(body(2), '"t2"'))).arrayBuffer();
  assertEquals(_encodedCacheSize(), 2);
  _clearEncodedCache();
});

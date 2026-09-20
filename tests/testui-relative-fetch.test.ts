// Under testUI a relative fetch has no server to reach. The call fails as it
// always did — but with a message that names the way out, not Deno's bare
// `Invalid URL`. A test's own fetch stub still answers relative URLs.
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { testUI } from "../src/cell-test.ts";
import { h } from "../src/air.ts";

const App = () => h("p", null, "hi");

Deno.test("testUI: a relative fetch fails with a message that names testServer", async () => {
  const before = globalThis.fetch;
  {
    await using _ui = await testUI(App);
    const e = await assertRejects(
      () => fetch("/media/hello.txt"),
      TypeError,
      'testUI: fetch("/media/hello.txt") is a relative URL',
    );
    assertEquals(e.message.includes("testServer()"), true);
    assertEquals((e.cause as Error).message.includes("Invalid URL"), true);
  }
  assertStrictEquals(globalThis.fetch, before, "fetch restored on dispose");
});

Deno.test("testUI: a fetch stub installed before the mount still answers relative URLs", async () => {
  const before = globalThis.fetch;
  const stub =
    ((input: string | URL | Request) =>
      Promise.resolve(new Response(`stub:${input}`))) as typeof fetch;
  globalThis.fetch = stub;
  try {
    {
      await using _ui = await testUI(App);
      assertEquals(await (await fetch("/api/x")).text(), "stub:/api/x");
    }
    assertStrictEquals(globalThis.fetch, stub, "the test's stub is kept");
  } finally {
    globalThis.fetch = before;
  }
});

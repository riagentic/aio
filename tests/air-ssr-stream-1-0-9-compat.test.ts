// renderToStream took the ROUTE at its call in 1.0.10 — and only the route.
// Each case below is a 1.0.9 pattern the first version of that change broke
// in silence, found by a differential run against the 1.0.9 tag:
//   - a stream created inside a server component and read after that page
//     ended became PART of the finished page: its `useId` sequence continued
//     the page's (`:r2:` for `:r0:`) and `collectHead(key)` came back empty;
//   - create the stream, await, set the route: 1.0.9 rendered the route set,
//     1.0.10 renders the one at the call — correct under concurrency, but it
//     must be SAID, not silent;
//   - two streams created, then the route set, in one turn: the second
//     stream's set-up counted as "another request", so the first kept its
//     call-time route (1.0.9 rendered the new one for both).
// Plus the abort path of the streamed Fragment: a client that goes away must
// leave no scope of the render open.

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectHead,
  Fragment,
  h,
  routePath,
  useHead,
  useId,
  useRoute,
} from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _ssrUnsettledCount, renderToString } from "../src/air/vdom-ssr.ts";
import { _ssrRenderForKey } from "../src/air/ssr-render.ts";
import { _resetHead } from "../src/air/head.ts";
import type { VNode } from "../src/air/vdom-types.ts";

async function drain(g: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const c of g) out += c;
  return out;
}

/** Run `fn` with `console.warn` captured; the lines it said. */
async function warnings(fn: () => Promise<void>): Promise<string[]> {
  _resetHead();
  const said: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
    routePath.set("/");
    _resetHead();
  }
  return said;
}

const tick = () => new Promise((r) => setTimeout(r, 1));
const Path = () => h("main", null, `path=${useRoute().path}`);
const BEFORE_PULL = "before the stream was first read";
const LATE = "set it BEFORE the call";

Deno.test("SSR stream 1.0.9: a stream created in a component and read after the page is its own render", async () => {
  await warnings(async () => {
    const KEY = {};
    const Island = () => {
      useHead({ title: "island" });
      return h("i", { id: useId() }, "isl");
    };
    let pending: AsyncGenerator<string> | null = null;
    const Outer = () => {
      pending = renderToStream(h(Island, null) as VNode, KEY);
      return h("div", { id: useId() }, h("span", { id: useId() }, "x"));
    };
    assertEquals(
      renderToString(h(Outer, null) as VNode),
      '<div id=":r0:"><span id=":r1:">x</span></div>',
    );
    assertEquals(collectHead(), "");
    // 1.0.9: its own id sequence, and its own head under its key.
    assertEquals(await drain(pending!), '<i id=":r0:">isl</i>');
    assertEquals(collectHead(KEY), "<title>island</title>");
  });
});

Deno.test("SSR stream 1.0.9: a stream first read INSIDE a component call is part of that page", async () => {
  const said = await warnings(async () => {
    const KEY = {};
    const Island = () => {
      useHead({ title: "island" });
      return h("i", { id: useId() }, "isl");
    };
    const s = renderToStream(h(Island, null) as VNode, KEY); // top level
    let first: Promise<IteratorResult<string, void>> | null = null;
    const Outer = () => {
      first = s.next(); // its first pull runs inside this call
      return h("div", { id: useId() }, "x");
    };
    // 1.0.9: the island took the page's first id and gave the page its head.
    assertEquals(
      renderToString(h(Outer, null) as VNode),
      '<div id=":r1:">x</div>',
    );
    assertEquals(collectHead(), "<title>island</title>");
    const r = await first!;
    assertEquals(
      (r.done ? "" : r.value) + await drain(s),
      '<i id=":r0:">isl</i>',
    );
    assertEquals(collectHead(KEY), "");
  });
  assertEquals(said, []);
});

Deno.test("SSR stream 1.0.9: create, await, set the route — the call's route is rendered, and said once per call site", async () => {
  const said = await warnings(async () => {
    const lateAfterAwait = async (p: string) => {
      routePath.set("/old");
      const body = renderToStream(h(Path, null) as VNode); // ONE call site
      await tick();
      routePath.set(p);
      return drain(body);
    };
    assertEquals(await lateAfterAwait("/new"), "<main>path=/old</main>");
    assertEquals(await lateAfterAwait("/new2"), "<main>path=/old</main>");
  });
  assertEquals(said.length, 1, said.join("\n"));
  assertStringIncludes(said[0]!, BEFORE_PULL);
  assertStringIncludes(said[0]!, "air-ssr-stream-1-0-9-compat.test.ts");
});

Deno.test("SSR stream 1.0.9: the correct concurrent shape — set, call, await; the next request sets and calls — says nothing", async () => {
  const said = await warnings(async () => {
    routePath.set("/a");
    const a = renderToStream(h(Path, null) as VNode);
    await tick();
    routePath.set("/b");
    const b = renderToStream(h(Path, null) as VNode);
    await tick();
    assertEquals(await drain(a), "<main>path=/a</main>");
    assertEquals(await drain(b), "<main>path=/b</main>");
  });
  assertEquals(said, []);
});

Deno.test("SSR stream 1.0.9: two streams created, then the route set, in one turn — both render it, and it is said", async () => {
  const said = await warnings(async () => {
    routePath.set("/old");
    const a = renderToStream(h(Path, null) as VNode);
    const b = renderToStream(h(Path, null) as VNode);
    routePath.set("/new");
    await tick();
    // Both took /old: the second is not ANOTHER request's route, so the
    // first may re-read — exactly 1.0.9's bytes.
    assertEquals(await drain(a), "<main>path=/new</main>");
    assertEquals(await drain(b), "<main>path=/new</main>");
  });
  assertEquals(said.filter((l) => l.includes(LATE)).length, 2, said.join("\n"));
});

Deno.test("SSR stream: a stream and a string render resumed by ONE promise each keep their route, silently", async () => {
  const said = await warnings(async () => {
    let go!: () => void;
    const ready = new Promise<void>((r) => go = r);
    const reqA = (async () => {
      await ready;
      routePath.set("/a");
      const s = renderToStream(h(Path, null) as VNode);
      await tick();
      return drain(s);
    })();
    const reqB = (async () => {
      await ready;
      routePath.set("/b");
      return renderToString(h(Path, null) as VNode);
    })();
    go();
    assertEquals(await Promise.all([reqA, reqB]), [
      "<main>path=/a</main>",
      "<main>path=/b</main>",
    ]);
  });
  assertEquals(said, [], "correct concurrent code was warned");
});

// The one 1.0.9 shape that renders differently AND cannot be said: create the
// stream, set the route, render a shell — in one turn. It is byte-for-byte the
// sequence two correct requests resumed by one promise produce (the test
// above), so a warning here would be a false one there. Listed in the
// upgrade guide instead.
Deno.test("SSR stream: create, set, render a shell in one turn keeps the call's route", async () => {
  const said = await warnings(async () => {
    routePath.set("/old");
    const body = renderToStream(h(Path, null) as VNode);
    routePath.set("/new");
    assertEquals(
      renderToString(h("i", null, "shell") as VNode),
      "<i>shell</i>",
    );
    await tick();
    assertEquals(await drain(body), "<main>path=/old</main>");
  });
  assertEquals(said, []);
});

// A route re-read at the end of the turn, then set BACK to the call's value
// before the first read, with nothing set up in between: that is still a
// change from what the stream settled on, and it is said.
Deno.test("SSR stream: a route set back to the call's value after the turn is still said at the first read", async () => {
  const said = await warnings(async () => {
    routePath.set("/a");
    const s = renderToStream(h(Path, null) as VNode);
    routePath.set("/x"); // same turn: re-read, rendered
    await tick();
    routePath.set("/a"); // after the turn, nobody rendered
    assertEquals(await drain(s), "<main>path=/x</main>");
  });
  assertEquals(said.filter((l) => l.includes(LATE)).length, 1, said.join("\n"));
  assertEquals(
    said.filter((l) => l.includes(BEFORE_PULL)).length,
    1,
    said.join("\n"),
  );
});

Deno.test("SSR stream: a client that goes away mid-Fragment leaves no <select> scope open", async () => {
  await warnings(async () => {
    const page = () =>
      h(
        Fragment,
        null,
        h(
          Fragment,
          null,
          h(
            "select",
            { value: "b" },
            h("option", { value: "a" }, "A"),
            h(Fragment, null, h("option", { value: "b" }, "B")),
          ),
        ),
        h("p", null, "tail"),
      ) as VNode;
    const whole = await drain(renderToStream(page()));
    const chunks = whole.length; // an upper bound on the chunk count
    let aborts = 0;
    for (let at = 1; at < chunks; at++) {
      const key = {};
      const g = renderToStream(page(), key);
      let n = 0, ended = false;
      while (n < at) {
        const r = await g.next();
        if (r.done) {
          ended = true;
          break;
        }
        n++;
      }
      if (ended) break;
      await g.return();
      aborts++;
      assertEquals(
        _ssrRenderForKey(key)!.selects.length,
        0,
        `aborted after chunk ${at}`,
      );
    }
    assertEquals(aborts > 4, true, `only ${aborts} abort points`);
  });
});

// Every stream waits to settle only until the end of the turn that created it
// — read to the end, returned early, or never read at all. A stream that
// stayed in the waiting set would pin every route snapshot set up after it.
Deno.test("SSR stream: no stream stays waiting to settle — read, aborted or never read", async () => {
  await warnings(async () => {
    const N = 5000;
    const kept: AsyncGenerator<string>[] = [];
    for (let i = 0; i < N; i++) {
      routePath.set("/p" + i);
      const g = renderToStream(h(Path, null) as VNode);
      if (i % 3 === 0) await drain(g);
      else if (i % 3 === 1) {
        await g.next();
        await g.return();
      } else kept.push(g); // created, never read
      if (i % 500 === 0) await tick();
    }
    await tick();
    assertEquals(_ssrUnsettledCount(), 0);
    assertEquals(kept.length, Math.floor(N / 3));
  });
});

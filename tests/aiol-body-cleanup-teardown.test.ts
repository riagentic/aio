// aiol: a body-level `onCleanup` that tears down what the body did not make.
//
// `onCleanup` in a component BODY runs on unmount AND before every re-render.
// That is documented and correct, and it is the easiest thing in aio to hold
// wrong — the body is where `useLocal` and `useRef` live, and every framework
// people arrive from ties a cleanup to an effect rather than to a repaint.
//
// A field report got it wrong four times in four components, each time
// silently, each time shipping, and the cost is the opposite of a leak: a
// resource that should outlive the render is destroyed on the next repaint,
// and nothing re-arms it because the component's own bookkeeping still says
// the work is in flight. 89 gallery cards asked for art, 4 started, 85 were
// cancelled and never asked again.
//
// It cannot be caught by a test, because a test renders ONCE and rendering
// once is exactly the case that works. It is caught here instead — and the
// four cases below are the four the report actually shipped.
//
// The discriminator, and the whole reason this is a rule and not a guess:
// per-render teardown is CORRECT when the body re-creates the thing each
// render, and wrong when it does not. The last two tests are the ones that
// keep this rule usable — a rule that fires on the correct shape gets muted,
// and then it protects nobody.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkBodyCleanupTeardown } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function issues(files: Record<string, string>) {
  const dir = await tempDir("aiol-body-cleanup-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkBodyCleanupTeardown(ctx);
    return report.issues;
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol: the gallery — a queue slot released from the body", async () => {
  // The report's costliest case. `slot` comes from a ref, so the next repaint
  // hands it back and nothing takes another.
  const found = await issues({
    "src/NftThumb.tsx": `import { onCleanup, useRef } from "aio/air";
export function NftThumb({ id }: { id: string }) {
  const slot = useRef(queue.take(id));
  onCleanup(() => slot.current.release());
  return <img src={id} />;
}
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found, null, 2));
  const i = found[0]!;
  assertEquals(i.severity, "warn");
  assert(i.message.includes("EVERY re-render"), i.message);
  assert(i.message.includes("slot"), i.message);
  assert(i.message.includes("onUnmount"), "it must name the fix");
});

Deno.test("aiol: the safety timer, the debounce, the retry", async () => {
  // The other three, each a handle the body does not create.
  const found = await issues({
    "src/ConfirmButton.tsx": `import { onCleanup, useRef } from "aio/air";
export function ConfirmButton() {
  const disarm = useRef(0);
  onCleanup(() => clearTimeout(disarm.current));
  return <button>send</button>;
}
`,
    "src/MintCostLine.tsx": `import { onCleanup, useRef } from "aio/air";
export function MintCostLine() {
  const debounce = useRef(0);
  onCleanup(() => clearTimeout(debounce.current));
  return <span>pricing…</span>;
}
`,
    "src/NftImageForm.tsx": `import { onCleanup, useRef } from "aio/air";
export function NftImageForm() {
  const retry = useRef<AbortController | null>(null);
  onCleanup(() => retry.current?.abort());
  return <form />;
}
`,
  });
  assertEquals(found.length, 3, JSON.stringify(found.map((i) => i.message)));
  for (const i of found) assert(i.message.includes("onUnmount"), i.message);
});

Deno.test("aiol: a cleanup for what the body DID create is left alone", async () => {
  // The correct per-render shape, and the one that keeps this rule usable.
  // `t` is made in this body and re-made on the next render, so clearing it
  // per render is not merely fine — it is required.
  const found = await issues({
    "src/Ticker.tsx": `import { onCleanup } from "aio/air";
export function Ticker() {
  const t = setTimeout(() => console.log("tick"), 400);
  onCleanup(() => clearTimeout(t));
  return <span>tick</span>;
}
`,
  });
  assertEquals(found, [], JSON.stringify(found, null, 2));
});

Deno.test("aiol: a cleanup registered INSIDE onMount is the recommended shape", async () => {
  // Registering there already means unmount-only. Flagging it would be
  // telling people off for doing what the message tells them to do.
  const found = await issues({
    "src/Poller.tsx": `import { onCleanup, onMount, useRef } from "aio/air";
export function Poller() {
  const handle = useRef(0);
  onMount(() => {
    handle.current = setInterval(poll, 400);
    onCleanup(() => clearInterval(handle.current));
  });
  return <span>polling</span>;
}
`,
  });
  assertEquals(found, [], JSON.stringify(found, null, 2));
});

Deno.test("aiol: an ordinary body cleanup with no teardown says nothing", async () => {
  // Idempotent bookkeeping is the common, correct use of a body cleanup.
  const found = await issues({
    "src/Row.tsx": `import { onCleanup } from "aio/air";
export function Row() {
  onCleanup(() => { rendered = false; });
  return <tr />;
}
`,
  });
  assertEquals(found, [], JSON.stringify(found, null, 2));
});

Deno.test("aiol: a `?.` between the handle and the teardown still counts", async () => {
  // The fourth shipped bug was written `retry.current?.abort()`, and the
  // rule's first draft walked past every one of those question marks — a rule
  // that misses the code it was written for. The root is also stripped of `?`
  // before it is interpolated into a RegExp: `a?` there means "an optional a"
  // and would match the wrong declaration.
  const found = await issues({
    "src/Deep.tsx": `import { onCleanup, useRef } from "aio/air";
export function Deep() {
  const conn = useRef<{ sock: { abort(): void } } | null>(null);
  onCleanup(() => conn.current?.sock?.abort());
  return <span />;
}
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found, null, 2));
  assert(found[0]!.message.includes("conn"), found[0]!.message);
});

// ── The false alarms. A rule that fires on its own recommended fix ──────────
//
// All three were measured on real code, one of them in a shipped app where
// the flagged line sat under a ten-line comment explaining why it is correct.
// They matter more than the true positives: a developer who already wrote the
// right thing, told confidently and wrongly to rewrite it, mutes the linter —
// and forty other rules ride on this one.

Deno.test("aiol: `onMount(() => onCleanup(…))` — no block body — is silent", async () => {
  // THE shape the rule's own message recommends, written as a one-liner. The
  // first version walked out through enclosing BLOCK bodies, and an
  // expression-bodied arrow has no block, so the walk found the COMPONENT's
  // body and flagged the fix as the bug.
  const found = await issues({
    "src/Confirm.tsx": `import { onCleanup, onMount, useRef } from "aio/air";
export function Confirm() {
  const timer = useRef(0);
  onMount(() => onCleanup(() => clearTimeout(timer.current)));
  return <button>send</button>;
}
`,
  });
  assertEquals(found, [], JSON.stringify(found, null, 2));
});

Deno.test("aiol: an `async` onMount callback is silent", async () => {
  // The most common async-setup shape there is. `async` was simply not in the
  // pattern that matched the text before the callback.
  const found = await issues({
    "src/Feed.tsx": `import { onCleanup, onMount, useRef } from "aio/air";
export function Feed() {
  const sub = useRef<{ unsubscribe(): void } | null>(null);
  onMount(async () => {
    sub.current = await open();
    onCleanup(() => sub.current?.unsubscribe());
  });
  return <ul />;
}
`,
  });
  assertEquals(found, [], JSON.stringify(found, null, 2));
});

Deno.test("aiol: a handle the body DESTRUCTURED is created here too", async () => {
  // `const { ctrl } = makeThing()` creates `ctrl` in this body exactly as
  // `const ctrl = …` does, so tearing it down per render is correct. Reading
  // only the plain declaration form made this a finding.
  const found = await issues({
    "src/Upload.tsx": `import { onCleanup } from "aio/air";
export function Upload() {
  const { ctrl } = makeThing();
  onCleanup(() => ctrl.abort());
  return <form />;
}
`,
  });
  assertEquals(found, [], JSON.stringify(found, null, 2));
});

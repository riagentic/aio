# Testing a canvas or 3D app

`testUI` drives a DOM. Under happy-dom there is no WebGL context, so
`canvas.getContext("webgl2")` returns `null` and anything built on it —
three.js, a 2D game loop, a video pipeline — cannot start. That is a real
limitation and not one aio is going to remove: a headless WebGL implementation
would be a second renderer to keep true, and a test that passes against a fake
GL is a test about the fake.

It leaves a question, though. In a canvas app the canvas _is_ the app, so "the
3D half has no test" means the largest and riskiest part of the codebase has
none.

The answer is not a better mock. It is to notice that almost nothing you want to
test is actually graphics.

## The shape that works

Take the decisions out of the imperative shell. "What should light up", "what
did the ray hit", "which chunk is visible from here", "is this drag a rotate or
a pan" are all **pure functions of what the renderer knows** — camera, pointer,
world, state. Only the calls that push bytes at the GPU are untestable, and
those are a thin layer with no branches worth covering.

```ts
// src/scene/pick.ts — pure. No canvas, no GL, no three.js import.
export type Ray = { origin: Vec3; direction: Vec3 };
export type Hit = { id: string; distance: number };

/** Which object a ray hits first, or null. */
export function pick(ray: Ray, world: readonly Solid[]): Hit | null {
  let best: Hit | null = null;
  for (const s of world) {
    const d = intersect(ray, s);
    if (d !== null && (best === null || d < best.distance)) {
      best = { id: s.id, distance: d };
    }
  }
  return best;
}
```

```ts
// src/scene/renderer.server.ts — the imperative shell. Untested on purpose:
// it has no decisions left in it.
function onPointerDown(e: PointerEvent) {
  const ray = camera.rayThrough(e.offsetX, e.offsetY); // three.js knows this
  const hit = pick(ray, world.solids); // ← the decision, pure
  if (hit) scene.select(hit.id); // ← the GL call, thin
}
```

Now the interesting half has ordinary tests:

```ts
Deno.test("the nearer solid wins, whatever order the world is in", () => {
  const near = solid("near", 1), far = solid("far", 9);
  assertEquals(pick(downRay, [far, near])?.id, "near");
  assertEquals(pick(downRay, [near, far])?.id, "near");
});

Deno.test("a ray that misses everything hits nothing", () => {
  assertEquals(pick(sidewaysRay, [solid("a", 1)]), null);
});
```

The rule of thumb: **if you can describe the behaviour without saying "canvas",
it should not need one to test.**

## Keep the state in a cell

The other half is easier than it looks. A canvas app still has state —
selection, camera pose, tool mode, loaded assets — and that state belongs in a
cell like any other. Cells are fully testable with
[`testCell`](cell-testing.md), no DOM at all:

```ts
testCell(
  editor,
  "selecting a solid replaces the previous selection",
  async (t) => {
    await t.send.select("a");
    await t.send.select("b");
    assertEquals(t.getState().selected, ["b"]);
  },
);
```

Push as much as you can across that line. A camera that lives in cell state is a
camera you can assert about; a camera that lives in a three.js object is one you
can only look at.

## What is left, and how to check it

After that, what remains untested is: does the GL context initialise, and do the
pixels look right. Two tools cover it, both outside `testUI`:

- **`am eval`** runs JavaScript inside the live renderer, so it can ask the real
  page real questions —
  `am eval 'document.querySelector("canvas").getContext("webgl2") !== null'`, or
  the frame counter your own loop keeps. That is a real browser with a real GPU,
  which is the only place those questions have true answers.
- **`am shot --check`** compares the rendered pixels against a committed
  baseline ([app-manager](../clients/app-manager.md#screenshots-am-shot)). With
  `am snapshot load` to fix the state first, this is a genuine visual regression
  test for the drawn output — the one thing a pure function cannot cover.

## Do not fake the context

It is tempting to hand `getContext` a stub so the code path runs. Resist it:
what you get is a test that proves your stub's shape, and it goes green on
exactly the changes that break the real thing. If a code path genuinely cannot
run without GL, that path belongs in the thin shell above — and the thin shell
is the part a screenshot check is for.

## See also

- [UI testing](ui-testing.md) — `testUI`, `am surface`, `am trigger`
- [Cell testing](cell-testing.md) — `testCell`
- [App manager](../clients/app-manager.md) — `am eval`, `am shot`

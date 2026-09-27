// docs/basics/cookbook.md recipe 4 promised: "If the call fails the optimistic
// layer still clears — it is tied to the passthrough value changing, not to
// success." A failed method changes NOTHING, so the passthrough never changes
// and the overlay never cleared: the page showed a like the server refused,
// until some unrelated success happened to change the count.
//
// The hook never sees the call, and giving it the call would reshape the
// FROZEN public signature (check:api refuses even an optional parameter). So
// the docs were corrected instead (cookbook recipe 4, docs/ui/air-lifecycle.md,
// the hook's JSDoc): the overlay is tied to passthrough, and the documented way
// to drop it on failure is a passthrough that also changes on refusal. These
// tests pin BOTH halves, so the docs cannot drift back into promising more.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { useOptimistic, useSignal } from "../src/air/aio-renderer.ts";
import { useMemo } from "../src/air/compat.ts";
import { signal } from "../src/state/signal.ts";

const likes = cell("optimisticFailedCallLikes", {
  state: { count: 0 },
  methods: {
    like(_s) {
      throw new Error("refused");
    },
  },
});

const tick = signal(0);

/** The cookbook's shape: the overlay is tied to the passthrough only. */
function PlainLikeButton() {
  void tick.value; // an unrelated re-render source
  const [shown, addOptimistic] = useOptimistic(
    likes.count,
    (current: number, delta: number) => current + delta,
  );
  return (
    <button
      type="button"
      t="like"
      onClick={() => {
        addOptimistic(1);
        void Promise.resolve(likes.like()).catch(() => {});
      }}
    >
      <span t="count">{String(shown)}</span> likes
    </button>
  );
}

/** docs/ui/air-lifecycle.md's pattern: a refusal count in the passthrough. */
function RefusalAwareLikeButton() {
  void tick.value;
  const refused = useSignal(0);
  const real = useMemo(() => ({ count: likes.count }), [
    likes.count,
    refused.value,
  ]);
  const [shown, addOptimistic] = useOptimistic(
    real,
    (current, delta: number) => ({ count: current.count + delta }),
  );
  return (
    <button
      type="button"
      t="like"
      onClick={() => {
        addOptimistic(1);
        Promise.resolve(likes.like()).catch(() =>
          refused.set(refused.peek() + 1)
        );
      }}
    >
      <span t="count">{String(shown.count)}</span> likes
    </button>
  );
}

async function clickAndFail(ui: { settle(): Promise<unknown> }) {
  await ui.settle().catch(() => {}); // the refusal is the setup
  await new Promise((r) => setTimeout(r, 50));
  tick.set(tick.peek() + 1); // any later render
  await ui.settle().catch(() => {});
}

Deno.test("useOptimistic: a failed call alone does NOT clear the overlay (as documented)", async () => {
  await using ui = await testUI(PlainLikeButton);
  ui.like.click();
  await clickAndFail(ui);
  assertEquals(likes.count, 0, "the server refused the like");
  assertEquals(
    ui.count.text,
    "1",
    "tied to passthrough, not to the call — if this now clears, the hook " +
      "learned about failures: update the docs that say it does not",
  );
});

Deno.test("useOptimistic: the documented refusal-count passthrough clears a failed call", async () => {
  await using ui = await testUI(RefusalAwareLikeButton);
  ui.like.click();
  await clickAndFail(ui);
  assertEquals(likes.count, 0, "the server refused the like");
  assertEquals(
    ui.count.text,
    "0",
    "the overlay must clear once the call has failed — the page shows a like " +
      "the server never accepted",
  );
});

// `useResource` and `onChange` — the two primitives a hand-rolled version got
// wrong, and every way it got them wrong.
//
// `resource()` covers "fetch when this changes". It does not cover a resource
// you HOLD — a camera, a socket, a GPU pipeline — where the close matters and
// the key decides which one you have. The reporting app wrote that itself and
// every one of its lifecycle bugs came out of that code (watcher §2, §8.5):
// two pipelines fighting over one camera on a remount, a hand-written
// `alive(s)` guard at ~twenty call sites each of which is a bug if forgotten,
// and a stale open installed over a newer one.
//
// And the rule deciding WHEN to swap could only live in a JSX handler, so
// `am dispatch settings:patch` changed the state and the camera stayed open
// (watcher §5, §8.4) — logically correct and genuinely surprising, which is
// what a missing primitive looks like.
import { assert, assertEquals } from "@std/assert";
import { signal } from "../src/state/signal.ts";
import {
  _openResourceCount,
  onChange,
  useResource,
} from "../src/air/use-resource.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ── onChange ────────────────────────────────────────────────────────────────

Deno.test("onChange waits for a CHANGE, and effect does not", () => {
  // "When the camera id changes, reopen the camera" written as a bare effect
  // opens a camera on boot that nobody asked for.
  const s = signal(1);
  const seen: number[] = [];
  const stop = onChange(() => s.value, (v) => seen.push(v));
  assertEquals(seen, [], "nothing yet — it has not changed");
  s.set(2);
  assertEquals(seen, [2]);
  s.set(2);
  assertEquals(seen, [2], "the same value again is not a change");
  s.set(3);
  assertEquals(seen, [2, 3]);
  stop();
  s.set(4);
  assertEquals(seen, [2, 3], "a disposed reaction is disposed");
});

Deno.test("onChange gives the previous value, and can run immediately", () => {
  const s = signal("a");
  const pairs: Array<[string, string | undefined]> = [];
  const stop = onChange(() => s.value, (v, p) => pairs.push([v, p]), {
    immediate: true,
  });
  assertEquals(pairs, [["a", undefined]]);
  s.set("b");
  assertEquals(pairs, [["a", undefined], ["b", "a"]]);
  stop();
});

Deno.test("only the SELECTOR is tracked — a reaction cannot loop on itself", () => {
  // The first thing anyone hits with a bare effect: the work reads other
  // state, subscribes to it, and re-runs forever.
  const key = signal(1);
  const other = signal(0);
  let runs = 0;
  const stop = onChange(() => key.value, () => {
    runs++;
    other.value; // read
    other.set(other.peek() + 1); // and write
  });
  key.set(2);
  assertEquals(runs, 1, `a self-feeding reaction ran ${runs} times`);
  other.set(99);
  assertEquals(runs, 1, "…and an unrelated write does not wake it");
  stop();
});

Deno.test("the CLEANUP runs before the next change, and on dispose", () => {
  // "Close the old camera, open the new one" as one function, with the close
  // attached to the open that made it.
  const s = signal("a");
  const log: string[] = [];
  const stop = onChange(() => s.value, (v) => {
    log.push(`open ${v}`);
    return () => log.push(`close ${v}`);
  }, { immediate: true });
  assertEquals(log, ["open a"]);
  s.set("b");
  assertEquals(log, ["open a", "close a", "open b"], "close BEFORE open");
  stop();
  assertEquals(log, ["open a", "close a", "open b", "close b"]);
});

// ── useResource ─────────────────────────────────────────────────────────────

function fakeCamera() {
  const log: string[] = [];
  let openCount = 0;
  const r = {
    log,
    get opens() {
      return openCount;
    },
    open: (id: string | number) => {
      openCount++;
      log.push(`open ${id}`);
      return Promise.resolve({ id });
    },
    close: (v: { id: string | number }) => {
      log.push(`close ${v.id}`);
    },
  };
  return r;
}

Deno.test("one open per key, reference-counted across holders", async () => {
  // Three components mounting the same resource fire three identical opens,
  // and there is no key to dedup on (composer §10.4).
  const cam = fakeCamera();
  const key = signal<string | null>("front");
  const mk = () =>
    useResource({
      key: () => key.value,
      open: cam.open,
      close: cam.close,
      scope: "cam-shared",
    });
  const a = mk(), b = mk(), c = mk();
  await tick();
  assertEquals(cam.opens, 1, "three holders, ONE open");
  assertEquals(a.value, b.value, "…and they hold the same thing");
  assertEquals(b.value, c.value);

  a.dispose();
  b.dispose();
  assertEquals(
    cam.log.filter((l) => l.startsWith("close")),
    [],
    "not closed while somebody is still holding it",
  );
  c.dispose();
  assertEquals(cam.log, ["open front", "close front"]);
  assertEquals(_openResourceCount(), 0, "and the table is empty again");
});

Deno.test("changing the key closes the old one BEFORE opening the new", async () => {
  // Two pipelines fighting over one camera, which is what happens when the
  // close lands after the open.
  const cam = fakeCamera();
  const key = signal<string | null>("front");
  const h = useResource({
    key: () => key.value,
    open: cam.open,
    close: cam.close,
    scope: "cam-swap",
  });
  await tick();
  key.set("back");
  await tick();
  assertEquals(cam.log, ["open front", "close front", "open back"]);
  assertEquals((h.value as { id: string }).id, "back");
  h.dispose();
  assertEquals(cam.log.at(-1), "close back");
});

Deno.test("a null key holds nothing, and releases what it held", async () => {
  const cam = fakeCamera();
  const key = signal<string | null>("front");
  const h = useResource({
    key: () => key.value,
    open: cam.open,
    close: cam.close,
    scope: "cam-null",
  });
  await tick();
  assert(h.value !== undefined);
  key.set(null);
  await tick();
  assertEquals(h.value, undefined);
  assertEquals(h.key.value, null);
  assertEquals(cam.log, ["open front", "close front"]);
  h.dispose();
});

Deno.test("a STALE open cannot install itself over a newer one", async () => {
  // The bug a hand-written `alive(s)` guard at twenty call sites is supposed
  // to prevent, and does not, because one of the twenty is always forgotten.
  const log: string[] = [];
  const key = signal("slow");
  const h = useResource<{ id: string }>({
    key: () => key.value,
    scope: "stale",
    open: (id) =>
      new Promise((r) =>
        setTimeout(() => {
          log.push(`opened ${id}`);
          r({ id: String(id) });
        }, id === "slow" ? 30 : 0)
      ),
    close: (v) => log.push(`closed ${v.id}`),
  });
  key.set("fast"); // before "slow" has landed
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(
    (h.value as { id: string }).id,
    "fast",
    "the NEWER key is what is held",
  );
  // …and the late one did not leak: it was closed rather than dropped.
  assert(log.includes("opened slow"), log.join(","));
  assert(log.includes("closed slow"), `a late open must be closed: ${log}`);
  h.dispose();
});

Deno.test("an open that THROWS reports the error and holds nothing", async () => {
  const h = useResource({
    key: () => "bad",
    scope: "throws",
    open: () => Promise.reject(new Error("no camera")),
  });
  await tick();
  assertEquals(h.value, undefined);
  assertEquals((h.error.value as Error)?.message, "no camera");
  assertEquals(h.loading.value, false);
  h.dispose();
  assertEquals(_openResourceCount(), 0);
});

Deno.test("a number key and a string key are different resources", async () => {
  const cam = fakeCamera();
  const a = useResource({
    key: () => 1,
    open: cam.open,
    close: cam.close,
    scope: "types",
  });
  const b = useResource({
    key: () => "1",
    open: cam.open,
    close: cam.close,
    scope: "types",
  });
  await tick();
  assertEquals(cam.opens, 2, '`1` and `"1"` must not share an open');
  a.dispose();
  b.dispose();
  assertEquals(_openResourceCount(), 0);
});

Deno.test("different SCOPES do not share, even with the same key", async () => {
  const cam = fakeCamera();
  const a = useResource({
    key: () => "x",
    open: cam.open,
    close: cam.close,
    scope: "one",
  });
  const b = useResource({
    key: () => "x",
    open: cam.open,
    close: cam.close,
    scope: "two",
  });
  await tick();
  assertEquals(cam.opens, 2);
  a.dispose();
  b.dispose();
  assertEquals(_openResourceCount(), 0);
});

Deno.test("dispose is idempotent, and a close that throws still releases", async () => {
  const h = useResource({
    key: () => "k",
    scope: "boom",
    open: () => Promise.resolve("v"),
    close: () => {
      throw new Error("close failed");
    },
  });
  await tick();
  h.dispose();
  h.dispose();
  assertEquals(
    _openResourceCount(),
    0,
    "a slot nobody can release is the leak this module exists to prevent",
  );
});

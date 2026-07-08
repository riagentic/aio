import { assertEquals } from "@std/assert";
import {
  batch,
  computed,
  effect,
  signal,
  untrack,
} from "../src/state/signal.ts";
import { on, watch } from "../src/state/watch.ts";

Deno.test("integration: updater + batch + watch work together", () => {
  const count = signal(0);
  const log: [number, number][] = [];

  const stop = watch(count, (next, prev) => {
    log.push([next, prev!]);
  });

  batch(() => {
    count.update((prev) => prev + 1);
    count.update((prev) => prev + 1);
  });

  // Batch: two updates, one notification, watch sees 0 -> 2
  assertEquals(count.value, 2);
  assertEquals(log, [[2, 0]]);

  stop();
});

Deno.test("integration: on() + untrack() in same effect", () => {
  const source = signal(0);
  const other = signal("hello");
  const log: string[] = [];

  const dispose = effect(on(source, (next, _prev) => {
    const msg = untrack(() => other.value);
    log.push(`${next}:${msg}`);
  }));

  source.set(1);
  assertEquals(log, ["1:hello"]);

  other.set("world"); // should NOT re-trigger
  assertEquals(log, ["1:hello"]);

  source.set(2); // SHOULD re-trigger, reads updated other via untrack
  assertEquals(log, ["1:hello", "2:world"]);

  dispose();
});

Deno.test("integration: watch + computed + updater", () => {
  const base = signal(10);
  const doubled = computed(() => base.value * 2);
  const log: [number, number][] = [];

  const stop = watch(doubled, (next, prev) => {
    log.push([next, prev!]);
  });

  base.update((prev) => prev + 5); // 10 -> 15, doubled: 20 -> 30
  assertEquals(log, [[30, 20]]);

  stop();
});

Deno.test("integration: batch + updater + shallow equality suppresses notify", () => {
  const obj = signal({ x: 1, y: 2 });
  let effectRuns = 0;
  const dispose = effect(() => {
    void obj.value;
    effectRuns++;
  });
  assertEquals(effectRuns, 1);

  // Updater returns shallow-equal object — should NOT trigger
  batch(() => {
    obj.update((prev) => ({ ...prev }));
  });
  assertEquals(effectRuns, 1); // suppressed by shallow equality

  // Updater returns genuinely different object — should trigger
  batch(() => {
    obj.update((prev) => ({ ...prev, x: 99 }));
  });
  assertEquals(effectRuns, 2);

  dispose();
});

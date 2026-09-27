// `useResource`'s `open` takes the key TYPE `key()` returns, not
// `string | number`.
//
// A field report's loader was typed `(lang: string, …)` against a key of
// `string | null`, and it failed to check (TS2322): `open` was declared
// `(key: string | number, …)`, so the app had to widen a correct signature.
// K is now inferred from `key()`'s non-null part. These are compile-time
// claims — `deno test` type-checks the file, so a regression fails before any
// assertion runs — plus the old spelling, which must keep compiling.
import { assertEquals } from "@std/assert";
import { signal } from "../src/state/signal.ts";
import { useResource } from "../src/air/use-resource.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("useResource: open/close take key()'s non-null type", async () => {
  const lang = signal<string | null>("en");
  const seen: string[] = [];
  const h = useResource({
    key: () => lang.value,
    open: (l: string) => {
      seen.push(l.toUpperCase()); // a `string` method — number would not have it
      return l.length;
    },
    close: (_n: number, l: string) => void seen.push(`-${l}`),
    scope: "use-resource-key-type",
  });
  await tick();
  lang.set(null);
  await tick();
  h.dispose();
  assertEquals(seen, ["EN", "-en"]);
});

Deno.test("useResource: an explicit (k: string | number) loader still compiles", async () => {
  const id = signal<string | null>("a");
  const h = useResource({
    key: () => id.value,
    open: (k: string | number) => String(k),
    close: (_v: string, _k: string | number) => {},
    scope: "use-resource-key-type-wide",
  });
  await tick();
  assertEquals(h.value, "a");
  h.dispose();
});

Deno.test("useResource: a numeric key stays numeric; a mixed key stays mixed", async () => {
  const n = signal<number | undefined>(7);
  const a = useResource({
    key: () => n.value,
    open: (k: number) => k * 2,
    scope: "use-resource-key-type-num",
  });
  const b = useResource({
    key: (): string | number | null => 3,
    open: (k) => typeof k,
    scope: "use-resource-key-type-mixed",
  });
  await tick();
  assertEquals([a.value, b.value], [14, "number"]);
  a.dispose();
  b.dispose();
});

Deno.test("useResource: open cannot claim a key type key() never returns", () => { // aio-ok: the @ts-expect-error is the assertion — type-check fails if it goes unused
  const id = signal<string | null>(null);
  const h = useResource({
    key: () => id.value,
    // @ts-expect-error — key() yields strings; a number-only loader is wrong
    open: (k: number) => k,
    scope: "use-resource-key-type-wrong",
  });
  h.dispose();
});

// The renderer's dev warnings must be ON wherever `__aioDev` is.
//
// AIR grew a SECOND dev flag beside `__aioDev`: `_devMode`, in five copies
// (vdom-types, renderer-rerender, renderer-lifecycle, signal, and the a11y
// check), fanned out from the public `setDevMode()`. Nothing in the framework
// ever called it, so the whole renderer warning layer — the conditional-hook
// tripwire, the infinite re-render detector, "recovered a stranded <X>, this
// is an aio scheduler bug, please report", onMount outside render, missing and
// duplicate keys, the entire a11y layer, hydration attribute parity — was
// behind a switch only an app could find. Eleven test files armed it by hand,
// so every one of them proved the warning WORKS and none proved it was ON:
// the "verify the instrument" trap, at layer scale.
//
// These tests assert the DEFAULT, which is the part that was missing.
import { assert, assertEquals } from "@std/assert";
import {
  _setDocument,
  mount,
  onMount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { isDevMode, isDevModeExplicit } from "../src/state/dev-flag.ts";
import { Window } from "happy-dom";

// Arm `__aioDev` exactly as the dev server's served shell and every test
// harness (`_armTestStrict`) do. A bare renderer unit test does not go through
// the harness, so it has to say so — and saying so is the point: these tests
// assert what happens when the DEV flag is the only thing that is set.
(globalThis as Record<string, unknown>).__aioDev = true;

/** Warnings emitted while `fn` renders. */
function warningsDuring(fn: (root: HTMLElement) => void): string[] {
  const win = new Window();
  // deno-lint-ignore no-explicit-any
  _setDocument(win.document as any);
  const seen: string[] = [];
  const realWarn = console.warn, realError = console.error;
  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  try {
    const root = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(root as never);
    fn(root);
  } finally {
    console.warn = realWarn;
    console.error = realError;
    _setDocument(undefined);
  }
  return seen;
}

Deno.test("dev warnings: no setDevMode() call is needed — __aioDev is enough", () => {
  // The harness arms `__aioDev`, exactly as the dev server does for a browser.
  assertEquals((globalThis as Record<string, unknown>).__aioDev, true);
  assertEquals(isDevMode(), true);
  // …and nothing has opted in explicitly.
  assertEquals(isDevModeExplicit(), false);

  const NoAlt = () => <img src="/x.png" />;
  const seen = warningsDuring((root) => mount(root, NoAlt));
  assert(
    seen.some((m) => m.includes("alt")),
    `expected an a11y warning without calling setDevMode; got ${
      JSON.stringify(seen)
    }`,
  );
});

Deno.test("dev warnings: a lifecycle hook outside a render is named too", () => {
  // A second, independent subsystem — `renderer-lifecycle` kept its own copy
  // of the flag, so proving one module is on proves nothing about the others.
  // `onMount`/`onCleanup` outside a render were dropped in SILENCE while
  // `afterRender`, `useRef` and `useSignal` all said so for the same mistake.
  const seen: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  try {
    onMount(() => {});
  } finally {
    console.warn = realWarn;
  }
  assert(
    seen.some((m) => m.includes("outside a component render")),
    JSON.stringify(seen),
  );
});

Deno.test('dev warnings: setDevMode("auto") returns to following __aioDev', () => {
  try {
    setDevMode(false);
    assertEquals(isDevMode(), false);
    // The boolean alone could not say "unset": with the flag defaulting from
    // __aioDev, an app that never called this and one that called
    // setDevMode(false) would otherwise be indistinguishable.
    setDevMode("auto");
    assertEquals(isDevMode(), true);
    assertEquals(isDevModeExplicit(), false);
  } finally {
    setDevMode("auto");
  }
});

Deno.test("dev warnings: forced off means silent, even in dev", () => {
  try {
    setDevMode(false);
    const NoAlt = () => <img src="/x.png" />;
    assertEquals(warningsDuring((root) => mount(root, NoAlt)), []);
  } finally {
    setDevMode("auto");
  }
});

Deno.test("dev warnings: data-component is opt-in, not ambient", () => {
  // It is the one dev feature that CHANGES the DOM, and SSR does not write
  // it — armed by default, every hydrated component would read as a
  // server/client divergence.
  const Page = () => <main>hi</main>;
  const win = new Window();
  // deno-lint-ignore no-explicit-any
  _setDocument(win.document as any);
  try {
    const root = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(root as never);
    mount(root, Page);
    assertEquals(root.innerHTML.includes("data-component"), false);

    setDevMode(true);
    const root2 = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(root2 as never);
    mount(root2, Page);
    assert(root2.innerHTML.includes('data-component="Page"'), root2.innerHTML);
  } finally {
    setDevMode("auto");
    _setDocument(undefined);
  }
});

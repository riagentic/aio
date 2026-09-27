// Android Back, for a page that navigates by state (a field report: a
// multi-screen reader app forked MainActivity.kt to get it). The shell calls
// `window.__aioBack()` and does its default only when that is not `true`.
import { assert, assertEquals } from "@std/assert";
import { onBackButton } from "../src/air.ts";
import { onBackButton as fromStandalone } from "../src/standalone-air.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const back = () =>
  (globalThis as unknown as { __aioBack: () => boolean }).__aioBack();

Deno.test("onBackButton: LIFO, false falls through, disposer removes exactly its own", () => {
  const seen: string[] = [];
  let screen = 2;
  const offScreen = onBackButton(() => {
    seen.push("screen");
    if (screen === 1) return false;
    screen--;
    return true;
  });
  const dialog = { open: true };
  const offDialog = onBackButton(() => {
    seen.push("dialog");
    if (!dialog.open) return false;
    dialog.open = false;
    return true;
  });
  try {
    assertEquals(back(), true); // the dialog, registered last, goes first
    assertEquals(back(), true); // dialog closed → falls through: screen 2 → 1
    assertEquals(back(), false); // on the first screen → Android's default
    assertEquals(seen, [
      "dialog",
      "dialog",
      "screen",
      "dialog",
      "screen",
    ]);
    offDialog();
    offDialog(); // idempotent — never removes someone else's
    seen.length = 0;
    screen = 2;
    assertEquals(back(), true);
    assertEquals(seen, ["screen"]);
  } finally {
    offDialog();
    offScreen();
  }
  assertEquals(back(), false, "no handlers left → default");
});

Deno.test("onBackButton: the same function registered twice is two entries", () => {
  let n = 0;
  const h = () => (n++, false);
  const a = onBackButton(h);
  const b = onBackButton(h);
  a();
  back();
  assertEquals(n, 1);
  b();
});

Deno.test("onBackButton: a throwing handler is loud and HANDLED (never closes the app)", () => {
  const errs: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a);
  const off = onBackButton(() => {
    throw new Error("boom");
  });
  try {
    assertEquals(back(), true);
  } finally {
    console.error = orig;
    off();
  }
  assertEquals(errs.length, 1);
  assert(String(errs[0]![0]).includes("onBackButton"));
});

Deno.test("onBackButton: one implementation on every entry, one global name in the shell", () => {
  assertEquals(fromStandalone, onBackButton);
  const kt = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;
  assert(
    kt.includes("typeof __aioBack == 'function' && __aioBack() === true"),
    "the Android shell must ask the page through the global onBackButton installs",
  );
  assert(kt.includes("private fun defaultBack()"));
});

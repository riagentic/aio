// tests/aio32-error-boundary.test.ts
// AIO-32: Error boundary death spiral — teardown nukes state while error UI is showing
//
// Root cause: when error boundary catches a render error, ALL children unmount,
// dropping _listeners to 0. After 300ms, the framework tears down state (_state = null).
// When user clicks "Retry Now", children remount with null state → immediate crash → loop.
//
// Fix: Error boundary subscribes to _subscribe, which:
// 1. Keeps _listeners.size > 0 → prevents 300ms teardown
// 2. Auto-recovers on state change → clears error when new state arrives

import { assertEquals } from "@std/assert";
import { generateHTML } from "../src/server-html.ts";

const html = generateHTML("test", false, false, "{}");

Deno.test("aio32: error boundary subscribes to _subscribe in componentDidMount", () => {
  const hasSubscribe = html.includes("_aioMod._subscribe");
  assertEquals(
    hasSubscribe,
    true,
    "error boundary must subscribe to _aioMod._subscribe",
  );
});

Deno.test("aio32: error boundary auto-clears error on state change", () => {
  // The subscription callback should reset error state when state changes
  const hasClearOnChange = html.includes("this.state.error") &&
    html.includes("this.setState({ error: null })");
  assertEquals(
    hasClearOnChange,
    true,
    "subscription must clear error on state change",
  );
});

Deno.test("aio32: error boundary unsubscribes in componentWillUnmount", () => {
  const hasUnsub = html.includes("componentWillUnmount") &&
    html.includes("this._unsub");
  assertEquals(hasUnsub, true, "error boundary must unsubscribe on unmount");
});

Deno.test("aio32: _aioMod set before createRoot().render()", () => {
  const aioModSetIdx = html.indexOf("_aioMod = aio");
  const createRootIdx = html.indexOf("createRoot(");
  assertEquals(aioModSetIdx > -1, true, "_aioMod must be set");
  assertEquals(createRootIdx > -1, true, "createRoot must exist");
  assertEquals(
    aioModSetIdx < createRootIdx,
    true,
    "_aioMod must be set BEFORE createRoot().render() so componentDidMount has access",
  );
});

Deno.test("aio32: _aioMod declared before _AioBoundary class", () => {
  const declIdx = html.indexOf("let _aioMod");
  const classIdx = html.indexOf("class _AioBoundary");
  assertEquals(declIdx > -1, true, "_aioMod must be declared");
  assertEquals(classIdx > -1, true, "_AioBoundary must exist");
  assertEquals(
    declIdx < classIdx,
    true,
    "_aioMod must be declared before _AioBoundary class (closure access)",
  );
});

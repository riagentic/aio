import { assertEquals, assertExists } from "@std/assert";

Deno.test("air entry: exports all AIR-native hooks", async () => {
  const air = await import("../src/air.ts");
  assertExists(air.useAio);
  assertExists(air.useLocal);
  assertExists(air.onMount);
  assertExists(air.onCleanup);
  assertExists(air.signal);
  assertExists(air.computed);
  assertExists(air.effect);
  assertExists(air.h);
  assertExists(air.mount);
  assertExists(air.createContext);
  assertExists(air.useContext);
  assertExists(air.useRef);
});

Deno.test("air entry: React compat hooks are NOT on the main surface", async () => {
  // useState/useEffect/useMemo/useCallback live only at "aio/air/compat".
  const air = await import("../src/air.ts") as Record<string, unknown>;
  assertEquals(air.useState, undefined);
  assertEquals(air.useEffect, undefined);
  assertEquals(air.useCallback, undefined);
  assertEquals(air.useMemo, undefined);
  // memo and useRef are native AIR primitives — they stay on "aio/air".
  assertExists(air.memo);
  assertExists(air.useRef);
});

Deno.test("air/compat: exports the React migration hooks", async () => {
  const compat = await import("../src/air-compat.ts");
  assertExists(compat.useState);
  assertExists(compat.useEffect);
  assertExists(compat.useCallback);
  assertExists(compat.useMemo);
  assertExists(compat.useRef);
});

Deno.test("air entry: protocol plumbing is NOT on the public surface", async () => {
  // A1 audit: state lives at "aio" (one obvious import path); protocol
  // internals stay in browser-air.ts / browser-protocol.ts for src/* + tests.
  const air = await import("../src/air.ts") as Record<string, unknown>;
  for (
    const hidden of [
      "cell",
      "aio",
      "log",
      "msg",
      "actions",
      "effects",
      "schedule",
      "bridge",
      "client",
      "matchPath",
      "ensureConnected",
      "setSyncMessageHandler",
      "_coreGetState",
      "_subscribe",
      "_trackingProxy",
    ]
  ) {
    assertEquals(air[hidden], undefined, `air must not export ${hidden}`);
  }
  // Documented user-facing survivors of the devtools/router groups.
  assertExists(air.navigate);
  assertExists(air.routePath);
  assertExists(air.connectDevTools);
});

Deno.test("air entry: exports VDOM extras", async () => {
  const air = await import("../src/air.ts");
  assertExists(air.Fragment);
  assertExists(air.ErrorBoundary);
  assertExists(air.lazy);
  assertExists(air.renderToString);
});

Deno.test("air entry: exports AIR utilities", async () => {
  const air = await import("../src/air.ts");
  assertExists(air.useForm);
  assertExists(air.useSpring);
  assertExists(air.useVirtualList);
  assertExists(air.connectAioDevTools);
});

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

Deno.test("air entry: React's hook names are on the main surface — the SAME functions as compat", async () => {
  // Since 1.0.6-beta: `import { useState } from "aio/air"` is the first line a
  // React-trained developer or agent writes, and it did not compile. One
  // implementation, two doors — never a second copy with its own contract.
  const air = await import("../src/air.ts") as Record<string, unknown>;
  const compat = await import("../src/air-compat.ts") as Record<
    string,
    unknown
  >;
  for (
    const name of ["useState", "useEffect", "useMemo", "useCallback", "useRef"]
  ) {
    assertExists(air[name], name);
    assertEquals(air[name], compat[name], `${name}: one function, not a twin`);
  }
  assertExists(air.memo);
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
  // alpha70 rename: connectDevTools → connectReduxDevTools (the Redux bridge).
  assertExists(air.connectReduxDevTools);
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

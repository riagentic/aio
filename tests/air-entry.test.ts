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

Deno.test("air entry: exports browser-side protocol symbols", async () => {
  const air = await import("../src/air.ts");
  assertExists(air.cell); // client-side cell (protocol-cell.ts)
  assertExists(air.aio); // client-side aio (protocol-cell.ts)
  assertExists(air.log); // client-side log (protocol-cell.ts)
  assertExists(air.msg); // client-side msg (browser-shared.ts)
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

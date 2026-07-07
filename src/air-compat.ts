// aio/air/compat — React migration hooks, off the main surface (AIO-7.6).
// These exist so React code compiles during migration; each logs a one-time
// dev hint pointing at the AIR-native equivalent:
//   useState   → useLocal() / signal()
//   useEffect  → onMount() / effect()
//   useMemo    → computed()
//   useCallback→ unnecessary (components are auto-optimized)
export { useCallback, useEffect, useMemo, useRef, useState } from "./compat.ts";

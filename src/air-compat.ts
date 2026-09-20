/**
 * @module
 * React's hooks — the same functions `aio/air` exports since 1.0.6-beta, kept
 * here so every import written for this entry keeps working. They behave as
 * React 19's (tests/react-patterns.test.ts) and print nothing.
 *
 * Stability: **permanent** (A5 decision, 2026-07-06). This entry is part of
 * the stable 1.0 surface — React migrations don't finish on our schedule.
 */
export {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "./air/compat.ts";

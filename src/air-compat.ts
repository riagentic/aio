/**
 * @module
 * React migration hooks — `aio/air/compat`, off the main surface (AIO-7.6).
 *
 * These exist so React code compiles during migration; each logs a one-time
 * dev hint pointing at the AIR-native equivalent:
 * - `useState` → `useLocal()` / `signal()`
 * - `useEffect` → `onMount()` / `effect()`
 * - `useMemo` → `computed()`
 * - `useCallback` → unnecessary (components are auto-optimized)
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

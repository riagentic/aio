// Public entry — implementation lives in testing/cell-test.ts
export * from "./testing/cell-test.ts";
// Transport cassettes (risoto #6): record a real device/network session once,
// replay it in CI forever. Record in prod against the real device; replay in tests.
export {
  type Cassette,
  type CassetteFrame,
  type CassetteMode,
  createCassette,
  openCassette,
} from "./state/cassette.ts";

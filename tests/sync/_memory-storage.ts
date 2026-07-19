// tests/sync/_memory-storage.ts — re-exports the SHIPPED in-memory storage so
// every sync test exercises the REAL code path (src/sync/op-buffer.ts) instead
// of a behaviourally-equivalent fork. Kept as a barrel so the existing import
// sites don't have to change. This is what real non-persistent apps use.
export { createMemoryStorage } from "../../src/sync/op-buffer.ts";

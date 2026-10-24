// For tests/crash-handler-tla-after-stray.test.ts: an entry whose top level
// awaits a worker cell's failing method after aio.run(). Re-imported by the
// worker, which skips the top-level call.
import { aio, cell, isCellWorker } from "../../mod.ts";

const tlaWorker = cell("tlaWorker", {
  worker: true,
  state: { n: 0 },
  methods: {
    async boom() {
      await Promise.resolve();
      throw new Error("boom in a worker method");
    },
  },
});

await aio.run({
  appId: "tla-worker-reject",
  cells: [tlaWorker],
  persist: false,
  watch: false,
  client: "server-only",
});
if (!isCellWorker()) {
  await (tlaWorker as unknown as { boom(): Promise<void> }).boom();
  console.log("UNREACHABLE");
}

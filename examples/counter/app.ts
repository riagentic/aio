// Entry point — define cell, wire to aio.run()
import { aio, cell } from "aio";

// persists by default — restart and count survives (persist: "all" is the default)
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});

await aio.run({
  appId: "counter",
  appVersion: "1.0.0",
  cells: [counter],
  baseDir: import.meta.dirname!,
});

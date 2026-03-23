// Entry point — define feature, wire to aio.run()
import { aio, feature } from "aio";

export const counter = feature("counter", {
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
  features: [counter],
  baseDir: import.meta.dirname!,
});

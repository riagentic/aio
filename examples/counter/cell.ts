// Cell — pure state + methods; UI and server both import from here
import { cell } from "aio";

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

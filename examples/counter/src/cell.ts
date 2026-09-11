// Cell — pure state + methods; UI and server both import from here.
import { cell } from "aio";

// Persists by default — restart and the count survives.
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

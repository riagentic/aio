// amui entry — the Aio Manager UI. Zero-config: the manager cell self-registers
// on import; auto-discovers once on boot.
import { manager } from "./manager.ts";
import { aio } from "aio";

await aio.run({
  appId: "amui",
  ui: {
    title: "amui — Aio Manager UI",
    width: 1240,
    height: 800,
    // Zero the default <body> margin (the white frame) + match the dark shell.
    head:
      "<style>html,body,#root{margin:0;height:100%;background:#0d1117;overflow:hidden}</style>",
  },
  // `select` writes a whole project's detail — its deno.json meta, every task
  // — into state synchronously, so the skeleton lands before the first await.
  // On a machine with dozens of discovered apps that is 5–9 ms, and the 5 ms
  // default effect budget reported it as an ERROR on every click. The instant
  // feedback is the point of that prefix (see manager.ts `select`); a human
  // cannot see 9 ms. Raised for THIS method only — every other effect in the
  // manager stays under the strict default.
  perfBudget: { methods: { "manager:select": { effect: 25 } } },
  onStart: () => {
    // Kick an initial scan after the callable surface is bound.
    manager.discover();
  },
});

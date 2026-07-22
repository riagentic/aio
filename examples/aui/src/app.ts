// aui entry — the aio UI manager. Zero-config: the manager cell self-registers
// on import; auto-discovers once on boot.
import { manager } from "./manager.ts";
import { aio } from "aio";

await aio.run({
  appId: "aui",
  ui: {
    title: "aui — aio manager",
    width: 1100,
    height: 720,
    // Zero the default <body> margin (the white frame) + match the dark shell.
    head:
      "<style>html,body,#root{margin:0;height:100%;background:#0d1117;overflow:hidden}</style>",
  },
  onStart: () => {
    // Kick an initial scan after the callable surface is bound.
    manager.discover();
  },
});

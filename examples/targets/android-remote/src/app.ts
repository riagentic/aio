// ex-android-remote — Android thin client — connect page, no local server logic
// Dev: deno task dev   Build: deno task compile
import { aio, cell } from "aio";

const _stub = cell("app", { state: {}, methods: {} });

await aio.run({
  appId: "ex-android-remote",
  appVersion: "0.1.0",
  cells: [_stub],
  ui: { title: "ex-android-remote" },
  baseDir: import.meta.dirname!,
});

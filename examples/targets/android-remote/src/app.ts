// ex-android-remote — Android thin client — connect page, no local server logic.
// Zero-config: the stub cell self-registers; identity infers from deno.json.
// Dev: deno task dev   Build: deno task compile
import { aio, cell } from "aio";

cell("app", { state: {}, methods: {} });

await aio.run();

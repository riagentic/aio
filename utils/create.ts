// Moved to src/create.ts so the scaffolder is publishable on JSR
// (`deno run -A jsr:@riagentic/aio/create my-app`). This shim keeps local
// callers (init.ts, older docs) working.
export { create } from "../src/create.ts";

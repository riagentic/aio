// protocol-router: the router core moved to src/air/router-core.ts — routing
// is state, and the standalone (android) entry needs the same core without a
// server transport. This module stays as the browser-side name for it.
export * from "../air/router-core.ts";

// Entry — cells self-register on import.
//
// `theme: "auto"` opts into aio's default look (it styles the semantic HTML
// and the card / row / stack / badge classes the UI uses) until you write
// `src/style.css`, at which point every visual default steps aside.
import "./cell.ts";
import { aio } from "aio";

export type { Filter, Todo } from "./cell.ts";

await aio.run({ ui: { theme: "auto" } });

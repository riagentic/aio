// Entry point — todo app with CRUD, filtering, persistence
import { aio } from "aio";
import { todo, view } from "./cell.ts";

export type { Filter, Todo } from "./cell.ts";
export { todo, view };

await aio.run({
  appId: "todo",
  appVersion: "1.0.0",
  cells: [todo, view],
  baseDir: import.meta.dirname!,
});

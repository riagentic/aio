// Entry point — todo app with CRUD, filtering, persistence. Zero-config:
// cells self-register on import; appId, version, and baseDir are inferred.
import "./cell.ts";
import { aio } from "aio";

export type { Filter, Todo } from "./cell.ts";

await aio.run();

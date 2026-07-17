// Entry point — zero-config: cells self-register on import; appId, version,
// and baseDir are inferred (docs/basics/quickstart.md).
import "./cell.ts";
import { aio } from "aio";

await aio.run();

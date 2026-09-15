#!/usr/bin/env -S deno run -A
// run-test-lane.ts — execute one testing lane from scripts/test-lanes.json.
//
//   deno run -A scripts/run-test-lane.ts fast
//   deno run -A scripts/run-test-lane.ts seam
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const lane = Deno.args[0];
if (lane !== "fast" && lane !== "seam") {
  console.error("usage: run-test-lane.ts fast|seam");
  Deno.exit(2);
}
const lanes = JSON.parse(
  Deno.readTextFileSync(join(ROOT, "scripts/test-lanes.json")),
) as { fast: string[]; seam: string[] };
const files = lane === "fast" ? lanes.fast : lanes.seam;
if (files.length === 0) {
  console.error(`lane ${lane} is empty`);
  Deno.exit(1);
}
const apps = Deno.env.get("AIO_APPS_DIR") ?? join(ROOT, ".aio-test-home");
const cmd = new Deno.Command(Deno.execPath(), {
  args: [
    "test",
    "-A",
    "--sanitize-ops",
    "--sanitize-resources",
    ...files,
  ],
  cwd: ROOT,
  env: { ...Deno.env.toObject(), AIO_APPS_DIR: apps },
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
});
const status = await cmd.output();
Deno.exit(status.code);

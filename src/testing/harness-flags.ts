/**
 * @module
 * The flags the TEST HARNESS answers (`--video*` for `testUI`), declared to
 * the CLI parser by every harness module that boots an app.
 *
 * A test process's `Deno.args` are the harness's arguments, and every boot
 * inside it (`testUI`'s refusals, `testServer`'s `aio.run`) parses them. The
 * declaration used to live in ui-video.ts alone, so `-- --video=dir/` was
 * accepted or "unknown flag" depending on whether that module happened to be
 * loaded — a test deep-importing `testServer` was refused. Imported by each
 * harness entry instead, and never by an app: an app that never loaded the
 * test harness still refuses `--video`.
 */

import { declareHarnessFlags } from "../server/aio-cli.ts";

/** The `--video*` flags `testUI` reads (see ui-video.ts). */
export const VIDEO_FLAGS: readonly string[] = [
  "--video",
  "--video-pace",
  "--video-scheme",
];

declareHarnessFlags(VIDEO_FLAGS.flatMap((f) => [f, `${f}=`]));

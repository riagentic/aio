// The per-user stores are this test file's from its FIRST line.
//
// The harness pins them on first use (`_armTestStrict`, `tempDir()`), which a
// test that calls an `am` command — or spawns one — before any of that never
// reaches: MEASURED 2026-10-10, such a file run on its own
// (`deno test -A tests/am-cmd.test.ts`, no runner, no `--preload`) put a
// checkout of the tree under test into `~/.local/lib/aio-versions/`, what
// every pinned app on the machine runs. Three files were fixed by hand; this
// is the class: a test file that reaches `am` imports this module (or
// `e2e-app-harness.ts`, which does), and
// tests/am-tests-arm-the-store-sandbox.test.ts refuses one that does not.
//
// Under the suite runner the variables are already set and this changes
// nothing.
import { _sandboxHomeStores } from "../src/testing/test-strict.ts";
_sandboxHomeStores();

// Loaded by the suite runner before any test file (`--preload`, see
// scripts/test-shards.ts).
//
// Windows keeps kernel32/advapi32 open for the life of the process;
// `src/server/win-pipe.ts` opens them when it loads. A test file that imports
// the framework statically has them before its first test. One that reaches
// it with `await import(…)` INSIDE a test body loads it there, and
// `--sanitize-resources` fails that test for "a dynamic library was loaded
// during the test, but not unloaded" — 28 files, measured on Windows 11. This
// makes the load the process's, which is whose it is. Off Windows it loads
// definitions and opens nothing.
//
// Running one such file by hand on Windows: `deno test -A
// --preload=tests/preload-ffi.ts tests/x.test.ts`.
import "../src/server/win-pipe.ts";

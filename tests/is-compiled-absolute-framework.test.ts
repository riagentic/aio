// Round 3 (server): `isCompiled()` read only its OWN module URL. `deno compile`
// serves project modules from `file:///tmp/deno-compile-<app>/…`, but a module
// reached through an ABSOLUTE specifier (an import map value
// `"/abs/aio/mod.ts"`) keeps its real `file:///abs/…` URL inside the binary —
// measured on Deno 2.9 with a real compile — so the framework said "not
// compiled" inside a compiled binary and ran the artifact as a dev checkout.
// The entry module is always the project's, so it answers too.
import { assertEquals } from "@std/assert";
import { _compiledFrom } from "../src/server/paths.ts";

Deno.test("isCompiled: an absolute-path framework inside a compiled binary still reads as compiled", () => {
  assertEquals(
    _compiledFrom(
      "file:///home/me/aio/src/server/paths.ts",
      "file:///tmp/deno-compile-app/home/me/app/src/app.ts",
      undefined,
    ),
    true,
  );
  // The unchanged rungs.
  assertEquals(
    _compiledFrom(
      "file:///tmp/deno-compile-app/x/dep/aio/src/server/paths.ts",
      "file:///tmp/deno-compile-app/x/src/app.ts",
      undefined,
    ),
    true,
  );
  assertEquals(
    _compiledFrom("file:///a/p.ts", "file:///a/app.ts", "/x.AppImage"),
    true,
  );
  assertEquals(
    _compiledFrom(
      "file:///home/me/aio/src/server/paths.ts",
      "file:///home/me/app/src/app.ts",
      undefined,
    ),
    false,
    "a plain `deno run` is not compiled",
  );
});

Deno.test("isCompiled: a dev checkout whose path contains deno-compile- is not compiled", () => {
  // `deno run /home/x/deno-compile-lab/src/app.ts` — the VFS segment is
  // `/deno-compile-<binary stem>/`, and the running binary is `deno`.
  assertEquals(
    _compiledFrom(
      "file:///home/x/deno-compile-lab/aio/src/server/paths.ts",
      "file:///home/x/deno-compile-lab/src/app.ts",
      undefined,
      "/home/x/.deno/bin/deno",
    ),
    false,
    "a dev checkout run by deno must not run as prod",
  );
  // The measured compiled shapes (Deno 2.9): TMPDIR moves the root, the stem
  // is the executable's name; a Worker sees the same. Windows: real Windows 11
  // with Deno 2.9.7 KEEPS `.exe` in the segment (a self-contained exe died
  // with "App.tsx not found at …\\deno-compile-mintest-win-x64.exe\\…" when
  // only the stripped form matched); the stripped form stays accepted.
  for (
    const [main, exec] of [
      ["file:///tmp/deno-compile-myapp/src/app.ts", "/opt/myapp"],
      ["file:///var/tmp/deno-compile-myapp/src/app.ts", "/opt/myapp"],
      [
        "file:///C:/Users/u/AppData/Local/Temp/deno-compile-myapp/src/app.ts",
        "C:\\Program Files\\myapp\\myapp.exe",
      ],
      [
        "file:///C:/Users/u/AppData/Local/Temp/deno-compile-myapp.exe/src/app.ts",
        "C:\\Program Files\\myapp\\myapp.exe",
      ],
      ["file:///tmp/deno-compile-my%20app/src/app.ts", "/opt/my app"],
      // A binary literally named `deno` is still a binary.
      ["file:///tmp/deno-compile-deno/src/app.ts", "/opt/deno"],
    ] as const
  ) {
    assertEquals(
      _compiledFrom(
        "file:///abs/aio/src/server/paths.ts",
        main,
        undefined,
        exec,
      ),
      true,
      `${main} run by ${exec}`,
    );
  }
});

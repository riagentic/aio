// `unsafeOutDir` compared paths byte-exactly, so on a case-insensitive
// filesystem (macOS / Windows defaults) `--out=Src` — which IS `src/` there —
// passed, and the build's out-dir wipe deleted the app's source. Protected
// dirs are compared case-folded.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { unsafeOutDir } from "../src/testing/internal.ts";
import { apartFrom, foldPath, realDir } from "../src/server/build-outputs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const root = join("/", "proj");

Deno.test("unsafeOutDir: a protected dir spelled in another case is refused", () => {
  for (const out of ["Src", "SRC", "src/Nested", ".GIT", ".Aio/x"]) {
    assertEquals(unsafeOutDir(join(root, out), root), true, out);
  }
});

Deno.test("unsafeOutDir: an ordinary build folder is still accepted", () => {
  for (const out of ["dist", "build", "Out", "srcs"]) {
    assertEquals(unsafeOutDir(join(root, out), root), false, out);
  }
});

Deno.test("unsafeOutDir: dist/ is folded too — `DIST/x` IS inside dist/", () => {
  // The dedicated dist check compared byte-exactly while the protected-dir
  // check folded, so `--out=DIST` and `--out=Dist/x` sailed through on a
  // case-insensitive host and a sibling target's dist/ wipe deleted them —
  // the exact case the guard exists for. `dist` (any case) itself stays legal.
  for (const out of ["DIST/x", "Dist/nested", "dIsT/x"]) {
    assertEquals(unsafeOutDir(join(root, out), root), true, out);
  }
  for (const out of ["dist", "DIST", "Dist"]) {
    assertEquals(unsafeOutDir(join(root, out), root), false, out);
  }
});

// The guard compared SPELLINGS. Windows drops the trailing dots and spaces of
// a name (`src.` and `src ` ARE `src` there), and a link to `src` is `src`
// under another name: each passed, and what was written landed in the app's
// sources.
Deno.test("unsafeOutDir: a name the strictest file system reads as a protected dir is refused", () => {
  for (
    const out of [
      "src ",
      "src.",
      "Src. .",
      "src./gen",
      ".git.",
      ".aio /x",
      "dist./x",
      "DIST /x",
    ]
  ) {
    assertEquals(
      unsafeOutDir(join(root, out), root),
      true,
      JSON.stringify(out),
    );
  }
  // The project itself, under such a name, is outside by its bytes — refused.
  for (const out of ["/proj.", "/PROJ", "/PROJ/release", "/proj /o1"]) {
    assertEquals(unsafeOutDir(out, root), true, out);
  }
  for (
    const out of [
      "release",
      "o1",
      "o1/o2",
      "src.d",
      "srcs",
      "a.src",
      "dist.",
      "out. ",
    ]
  ) {
    assertEquals(
      unsafeOutDir(join(root, out), root),
      false,
      JSON.stringify(out),
    );
  }
  assertEquals(
    ["/p/Src. /A.b./c", "/p/.../x", "/p/.aio", "/"].map(foldPath),
    ["/p/src/a.b/c", "/p/.../x", "/p/.aio", "/"],
  );
});

Deno.test({
  name:
    "unsafeOutDir: a link is the directory it leads to — to src, into an app dir, out of the project, or the project under another name",
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmp = await tempDir("aio-out-dir-links-");
    try {
      const proj = join(tmp, "proj");
      for (const d of ["src/gen", "apps/web", "release", "dist"]) {
        await Deno.mkdir(join(proj, d), { recursive: true });
      }
      await Deno.mkdir(join(tmp, "elsewhere"));
      await Deno.symlink("src", join(proj, "srclink"));
      await Deno.symlink("src/gen", join(proj, "genlink"));
      await Deno.symlink(join(proj, "apps"), join(proj, "appslink"));
      await Deno.symlink(join(tmp, "elsewhere"), join(proj, "away"));
      await Deno.symlink("release", join(proj, "rel"));
      await Deno.symlink(proj, join(tmp, "alias"));
      await Deno.symlink(join(proj, "src"), join(tmp, "elsewhere", "in"));
      const apps = [join(proj, "apps/web")];
      const guard = (out: string, root = proj) =>
        unsafeOutDir(join(root, out), root, apps);
      assertEquals(
        [
          "srclink",
          "srclink/new",
          "genlink",
          "appslink",
          "appslink/web/out",
          "away",
          "away/x",
        ]
          .map((o) => [o, guard(o)]),
        [
          "srclink",
          "srclink/new",
          "genlink",
          "appslink",
          "appslink/web/out",
          "away",
          "away/x",
        ]
          .map((o) => [o, true]),
      );
      // A link to an ordinary folder, and a folder not there yet, are fine —
      // and so is the project reached through a link.
      assertEquals(
        [guard("rel"), guard("release"), guard("new/deep"), guard("dist")],
        [false, false, false, false],
      );
      const alias = join(tmp, "alias");
      assertEquals(
        [guard("release", alias), guard("src", alias), guard("srclink", alias)],
        [false, true, true],
      );
      assertEquals(unsafeOutDir(join(alias, "release"), proj, apps), false);
      // An app dir named through the link is the app dir.
      assertEquals(
        unsafeOutDir(join(alias, "apps/web/out"), alias, [
          join(alias, "apps/web"),
        ]),
        true,
      );
      // Outside the project by name, inside it in fact.
      assertEquals(unsafeOutDir(join(tmp, "elsewhere/in"), proj), true);
      assertEquals(
        [
          apartFrom(proj, join(tmp, "elsewhere")),
          apartFrom(proj, join(tmp, "elsewhere/in")),
          apartFrom(proj, join(tmp, "alias/release")),
          apartFrom(proj, tmp),
          apartFrom(proj, join(proj, "away")),
        ],
        [true, false, false, false, true],
      );
      assertEquals(
        realDir(join(proj, "srclink/not/there")),
        join(await Deno.realPath(proj), "src/not/there"),
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});

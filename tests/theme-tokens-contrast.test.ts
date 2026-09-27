// (a) The `prefers-contrast: more` TOKEN overrides (`--aio-border`/`--aio-muted`
//     → ink, shadows off) are custom properties — as inert as the dark-mode
//     block the tokens slice already keeps — yet they sit after the `canvas`
//     banner, so `ui.theme: "tokens"` (the DEFAULT) never gets them. The kit
//     and every app reading `var(--aio-border)` stays low-contrast for a user
//     who asked the OS for more.
// (b) docs/ui/theme.md (and appThemeBaseCss's own doc comment) say the kept
//     environments are "coarse pointer, reduced motion, print". There is no
//     `@media print` anywhere in the theme.
import { assert } from "@std/assert";
import {
  appThemeBaseCss,
  appThemeCss,
  appThemeTokensCss,
} from "../src/build/app-theme.ts";

Deno.test("tokens theme keeps the prefers-contrast:more token overrides the full theme has", () => {
  assert(appThemeCss("demo").includes("prefers-contrast:more"));
  const tokens = appThemeTokensCss("demo");
  assert(
    /prefers-contrast:\s*more[^{]*\{\s*:root\s*\{[^}]*--aio-border/.test(
      tokens,
    ),
    `"tokens" theme has no high-contrast token overrides:\n${
      tokens.slice(-400)
    }`,
  );
});

Deno.test("no doc claims the theme keeps 'print' unless a print rule backs it", async () => {
  const hasPrint = /@media[^{]*\bprint\b/.test(appThemeBaseCss("demo"));
  for (
    const f of ["../docs/ui/theme.md", "../src/server/aio-types.ts"]
  ) {
    const text = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(
      hasPrint || !/reduced motion,\s*(?:\*\s*)?print/.test(text),
      `${f} says the theme keeps "print", but it has no @media print`,
    );
  }
});

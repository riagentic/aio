// `htmlOpen` is "ONE spelling, on every shell" because hand-written
// `<html>` tags shipped without `lang` (WCAG 2.1 SC 3.1.1, Level A). The
// Electron connect screen (`CONNECT_HTML`, loaded as a data: URL by the thin
// client) is still a bare `<html>`.
import { assertMatch } from "@std/assert";
import { CONNECT_HTML } from "../src/electron/electron-shared.ts";

Deno.test("Electron CONNECT_HTML declares a document language", () => {
  assertMatch(CONNECT_HTML, /<html\s[^>]*\blang="[^"]+"/);
});

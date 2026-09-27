// The AppImage's .desktop `Name=` took the display title raw. In a desktop
// entry backslash is the escape character, so a literal one in a title was
// read back as an escape, and a line break would start a new key.
import { assertEquals } from "@std/assert";
import { desktopString } from "../src/build/build-electron.ts";

Deno.test("desktopString: backslash and line breaks are escaped per the spec", () => {
  assertEquals(desktopString("Counter"), "Counter");
  assertEquals(desktopString("C:\\Tools"), "C:\\\\Tools");
  assertEquals(desktopString("a\\sb"), "a\\\\sb");
  assertEquals(desktopString("x\nExec=evil"), "x\\nExec=evil");
  assertEquals(desktopString("t\tr\r"), "t\\tr\\r");
});

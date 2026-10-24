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

// The window's class (windowClassName) and the entry's StartupWMClass are one
// answer — the id the binary runs as — so a panel matches the window to the
// AppImage's entry and to the menu entry run.sh copies it into.
Deno.test("linuxDesktopEntry: StartupWMClass is the window's class", async () => {
  const { linuxDesktopEntry } = await import("../src/build/build-electron.ts");
  const { windowClassName } = await import(
    "../src/electron/electron-shared.ts"
  );
  const line = (s: string) => /^StartupWMClass=(.*)$/m.exec(s)?.[1];
  assertEquals(
    line(linuxDesktopEntry("Counter", "counter", undefined)),
    "counter",
  );
  assertEquals(
    line(linuxDesktopEntry("Counter", "counter-app", "my-counter")),
    windowClassName({ appId: "my-counter" }),
  );
});

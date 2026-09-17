// An EXPLICIT browser — `{ browserPath }` or `$CHROMIUM_BIN` — that does not
// exist is refused at the call, by name. It used to be returned unchecked, so
// `testBrowser` rejected LATER with a raw "Failed to spawn" (its comment says
// "throws at the call"), and `testUI --video` rendered the whole test before
// failing at dispose with an OS error that named neither the variable nor
// the fix.
import { assertEquals, assertThrows } from "@std/assert";
import { chromiumBin } from "../src/testing/chromium.ts";
import { testBrowser } from "../src/testing/server-test.ts";
import { dropTempDir, tempDirSync } from "../src/testing/temp-dir.ts";

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prior = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    return fn();
  } finally {
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  }
}

Deno.test("testBrowser: a missing browserPath throws synchronously, naming it", () => {
  assertThrows(
    () =>
      void testBrowser("http://127.0.0.1:1/", {
        browserPath: "/nonexistent/chrome",
      }),
    Error,
    "[testBrowser] no headless Chromium/Chrome at /nonexistent/chrome",
  );
});

Deno.test("chromiumBin: a missing $CHROMIUM_BIN is named, before anything runs", () => {
  withEnv(
    "CHROME_BIN",
    undefined,
    () =>
      withEnv("CHROMIUM_BIN", "/nonexistent/chromium", () => {
        assertThrows(
          () => chromiumBin("[aio:video] testUI --video"),
          Error,
          "$CHROMIUM_BIN=/nonexistent/chromium does not exist",
        );
      }),
  );
});

Deno.test("chromiumBin: a bare command name is looked up on PATH, not stat'ed in the cwd", async () => {
  const dir = tempDirSync("aio-chromium-bin-");
  try {
    const exe = `${dir}/fake-chromium`;
    Deno.writeTextFileSync(exe, "#!/bin/sh\n");
    Deno.chmodSync(exe, 0o755);
    withEnv("PATH", `${dir}:${Deno.env.get("PATH") ?? ""}`, () => {
      assertEquals(chromiumBin("x", "fake-chromium"), "fake-chromium");
      assertThrows(
        () => chromiumBin("x", "no-such-chromium-anywhere"),
        Error,
        "not found on PATH",
      );
    });
  } finally {
    await dropTempDir(dir);
  }
});

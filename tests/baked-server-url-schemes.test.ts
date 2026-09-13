// `build.server` is baked into shipped clients — so every spelling a person
// writes must bake the SAME server, and one that is not an address must refuse
// the build rather than ship a client that asks for it.
//
// The scheme test was a case-sensitive `^https?://`. Anything else got
// `http://` glued on the front and the URL parser read the old scheme as the
// HOSTNAME: `wss://relay.example.com:8443` baked `http://wss` into the APK and
// the Electron client, `HTTP://Host:8000` baked `http://http`. And an
// unparseable value (`host:99999`) came back null — the same answer as
// "declared nothing" — so the client silently opened the address picker.
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { bakedServerUrl } from "../src/server/paths.ts";
import { buildAll } from "../src/build-all.ts";

Deno.test("bakedServerUrl: ws/wss and any-case schemes name the same server", () => {
  assertEquals(
    bakedServerUrl("wss://relay.example.com:8443"),
    "https://relay.example.com:8443",
  );
  assertEquals(bakedServerUrl("ws://host:8000"), "http://host:8000");
  assertEquals(bakedServerUrl("HTTP://Host:8000"), "http://host:8000");
  assertEquals(
    bakedServerUrl("Https://relay.example"),
    "https://relay.example",
  );
  assertEquals(bakedServerUrl("WSS://relay.example"), "https://relay.example");
  // Unchanged: no scheme → http, IPv6 literal kept.
  assertEquals(bakedServerUrl("localhost:8000"), "http://localhost:8000");
  assertEquals(bakedServerUrl("[::1]:8000"), "http://[::1]:8000");
});

Deno.test("bakedServerUrl: a declared value that is not an address throws, naming it", () => {
  for (const bad of ["host:99999", "host:abc", "ftp://files.example", "a b"]) {
    assertThrows(() => bakedServerUrl(bad), Error, `"${bad}"`);
  }
  assertThrows(
    () => bakedServerUrl(8000 as unknown as string),
    Error,
    "must be a string",
  );
  // Declaring nothing is still null, not an error.
  assertEquals(bakedServerUrl(""), null);
  assertEquals(bakedServerUrl(undefined), null);
});

Deno.test("build-all: an unparseable build.server refuses the fleet before any target builds", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-bad-server-" });
  const stub = join(dir, "stub-build.ts");
  // A build that ran at all would leave this file behind.
  await Deno.writeTextFile(
    stub,
    `await Deno.writeTextFile(Deno.cwd() + "/ran.log", "ran");`,
  );
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "bad server probe",
      build: { targets: ["server", "electron-client"], server: "host:99999" },
    }),
  );
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  const origErr = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  Object.defineProperty(Deno, "args", {
    value: [`--build-spec=${stub}`],
    configurable: true,
  });
  Deno.chdir(dir);
  try {
    const code = await buildAll();
    assertEquals(code, 1);
    assertEquals(
      errs.some((l) => l.includes('build.server "host:99999"')),
      true,
      errs.join("\n"),
    );
    assertEquals(
      await Deno.stat(join(dir, "ran.log")).then(() => true, () => false),
      false,
      "no target may build",
    );
  } finally {
    console.error = origErr;
    Deno.chdir(origCwd);
    Object.defineProperty(Deno, "args", {
      value: origArgs,
      configurable: true,
    });
    await Deno.remove(dir, { recursive: true });
  }
});

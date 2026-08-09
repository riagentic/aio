// `build.server` reaches the artifact, instead of being printed and forgotten.
//
// The fleet recorded the address, printed it at the end of a build, and REFUSED
// a client-only build without it — and then the APK or AppImage that came out
// opened a box asking the user to type the server the build already knew. One
// field deployment worked around it by rewriting a build-time constant.
import { assert, assertEquals } from "@std/assert";
import { bakedServerUrl } from "../src/server/paths.ts";
import { electronClientScript } from "../src/electron/electron.ts";
import { _writeConnectPage } from "../src/build/build-android.ts";
import { join } from "@std/path";

Deno.test("bakedServerUrl: a scheme is inferred, not demanded", () => {
  // `192.168.1.50:8000` is what people write in a config file. Demanding
  // http:// there is the ceremony that gets an option abandoned.
  assertEquals(bakedServerUrl("192.168.1.50:8000"), "http://192.168.1.50:8000");
  assertEquals(bakedServerUrl("wallet.local"), "http://wallet.local");
  assertEquals(
    bakedServerUrl("https://wallet.example"),
    "https://wallet.example",
  );
  assertEquals(bakedServerUrl(" 10.0.0.2:9000 "), "http://10.0.0.2:9000");
});

Deno.test("bakedServerUrl: no trailing slash — it is concatenated downstream", () => {
  assertEquals(bakedServerUrl("http://a.b/"), "http://a.b");
  assertEquals(bakedServerUrl("http://a.b/path"), "http://a.b");
});

Deno.test("bakedServerUrl: nothing declared is null, not a guess", () => {
  for (const v of [undefined, null, "", "   "]) {
    assertEquals(bakedServerUrl(v), null);
  }
});

Deno.test("electron client: the baked address is a DEFAULT, not a lock", () => {
  const script = electronClientScript("http://10.0.0.5:8000");
  assert(
    script.includes('__AIO_BAKED_URL = "http://10.0.0.5:8000"'),
    "the address must reach the artifact",
  );
  // Precedence: an explicit flag and an imported profile are someone choosing
  // THIS run, so both are checked before the baked default.
  const bakedAt = script.indexOf("__AIO_BAKED_URL &&");
  const directAt = script.indexOf("if (directUrl)");
  const profileAt = script.indexOf("if (profileFile)");
  assert(directAt > 0 && profileAt > 0 && bakedAt > 0);
  assert(directAt < bakedAt, "--server-url outranks the baked default");
  assert(profileAt < bakedAt, "an imported profile outranks it too");
  // …and the picker is always one flag away when the server has moved.
  assert(
    script.includes("!process.argv.includes('--connect')"),
    "--connect must still reach the connect page",
  );
});

Deno.test("electron client: no baked address leaves today's behaviour exactly", () => {
  const script = electronClientScript();
  assert(script.includes("__AIO_BAKED_URL = null"));
  assertEquals(script, electronClientScript(null), "null and absent agree");
});

Deno.test("android client: prefilled and auto-connected on a FRESH install only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-connect-" });
  try {
    await _writeConnectPage(dir, "Wallet", "http://10.0.0.5:8000");
    const html = await Deno.readTextFile(join(dir, "index.html"));
    assert(
      html.includes('var baked="http://10.0.0.5:8000"'),
      "address embedded",
    );
    // The first launch of an installed client should not be a form.
    assert(
      html.includes("!localStorage.getItem('aio_server')"),
      "auto-connect only when the user has never chosen a server",
    );
    // A stored choice — including one the user deliberately changed — wins.
    assert(
      html.includes("localStorage.getItem('aio_server')||baked"),
      "a stored server outranks the baked one",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("android client: no baked address still gives the plain form", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-connect-" });
  try {
    await _writeConnectPage(dir, "Wallet");
    const html = await Deno.readTextFile(join(dir, "index.html"));
    assert(html.includes('var baked=""'), "empty, never undefined in JS");
    assert(html.includes('id="addr"'), "the form is still the fallback");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// `build.server` reaches the artifact, instead of being printed and forgotten.
//
// The fleet recorded the address, printed it at the end of a build, and REFUSED
// a client-only build without it — and then the APK or AppImage that came out
// opened a box asking the user to type the server the build already knew. One
// field deployment worked around it by rewriting a build-time constant.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

/** Run the connect page's script against stub storage and a stub location:
 *  where does a launch GO? (null = it stays on the form.) */
function launch(
  html: string,
  local: Map<string, string>,
  hash = "",
  err = { textContent: "" },
): { went: string | null; field: string } {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const field = { value: "" };
  const start =
    `https://appassets.androidplatform.net/assets/index.html${hash}`;
  const location = { href: start, hash };
  new Function("localStorage", "location", "document", script)(
    {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
    },
    location,
    {
      getElementById: (id: string) => id === "addr" ? field : err,
    },
  );
  return {
    went: location.href === start ? null : location.href,
    field: field.value,
  };
}

Deno.test("client connect page: every launch goes straight in; #change (Back) stays on the form", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-connect-" });
  try {
    await _writeConnectPage(dir, "Wallet", "http://10.0.0.5:8000");
    const html = await Deno.readTextFile(join(dir, "index.html"));
    const local = new Map<string, string>();
    // Fresh install: the baked address, no form.
    assertEquals(launch(html, local).went, "http://10.0.0.5:8000");
    // Back from the server opens `#change`: the form, prefilled, to change it.
    const back = launch(html, local, "#change");
    assertEquals(back.went, null);
    assertEquals(back.field, "http://10.0.0.5:8000");
    // The client could not reach it: the form, SAYING so — not a loop.
    const err = { textContent: "" };
    assertEquals(launch(html, local, "#unreachable", err).went, null);
    assertStringIncludes(
      err.textContent,
      "Could not reach http://10.0.0.5:8000",
    );
    // A later launch: straight in again — it used to stop on the form on
    // every launch after the first.
    assertEquals(launch(html, local).went, "http://10.0.0.5:8000");
    // The user's own choice outranks the baked one, at every launch.
    local.set("aio_server", "http://192.168.1.9:8000");
    assertEquals(launch(html, local).went, "http://192.168.1.9:8000");
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
    assertEquals(launch(html, new Map()).went, null, "and it stays on it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

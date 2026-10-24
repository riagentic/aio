// `build.server` reaches the artifact, instead of being printed and forgotten.
//
// The fleet recorded the address, printed it at the end of a build, and REFUSED
// a client-only build without it — and then the APK or AppImage that came out
// opened a box asking the user to type the server the build already knew. One
// field deployment worked around it by rewriting a build-time constant.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bakedServerUrl } from "../src/server/paths.ts";
import { electronClientScript } from "../src/electron/electron.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
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
  const directAt = script.indexOf("if (!bootErr && directUrl)");
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
  err: { textContent: string; onsubmit?: (e: unknown) => void } = {
    textContent: "",
  },
  /** The shell's pairing bridge (`AioConnect` in MainActivity.kt) — absent
   *  on a WebView without one. It answers in a later microtask, as a
   *  message does. */
  shell?: (q: Record<string, unknown>) => Record<string, unknown>,
): {
  went: string | null;
  field: string;
  /** The shell sends the page to `hash` while it is the page showing. */
  rehash: (hash: string) => void;
  /** Type `url` into the form and tap Connect. */
  connect: (url: string) => void;
  /** Every address the page opened, in order. */
  visited: string[];
  /** The pairing-code field (and the warning line: one stub for both). */
  pinField: { value: string; textContent: string };
} {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const field = { value: "" };
  const start =
    `https://appassets.androidplatform.net/assets/index.html${hash}`;
  const visited: string[] = [];
  const location = {
    get href() {
      return visited.at(-1) ?? start;
    },
    set href(v: string) {
      visited.push(v);
    },
    hash,
    pathname: "/assets/index.html",
  };
  const window: { onhashchange?: () => void } = {};
  // Every other element the page touches (the pairing field, the warning).
  const other = { value: "", textContent: "" };
  const bridge: {
    onmessage?: (e: { data: string }) => void;
    postMessage: (m: string) => void;
  } = {
    postMessage: (m) => {
      const q = JSON.parse(m);
      const r = JSON.stringify({ id: q.id, ...shell!(q) });
      queueMicrotask(() => bridge.onmessage?.({ data: r }));
    },
  };
  new Function(
    "localStorage",
    "location",
    "document",
    "window",
    "history",
    "AioConnect",
    script,
  )(
    {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
    },
    location,
    {
      getElementById: (id: string) =>
        id === "addr" ? field : id === "err" || id === "f" ? err : other,
    },
    window,
    { replaceState: () => location.hash = "" },
    shell ? bridge : undefined,
  );
  return {
    get went() {
      return location.href === start ? null : location.href;
    },
    get field() {
      return field.value;
    },
    rehash: (h) => {
      location.hash = h;
      window.onhashchange?.();
    },
    connect: (url) => {
      field.value = url;
      err.onsubmit!({ preventDefault: () => {} });
    },
    visited,
    pinField: other,
  };
}

/** Let the bridge's answers (microtasks) land. */
const answered = () => new Promise((r) => setTimeout(r, 0));

// The form kept the address in localStorage alone, and a WebView writes that
// to disk when it gets to it. Measured on an API 35 emulator: a kill within a
// second of pairing brought the client back to "needs its key" — and a
// pairing code works once. The shell keeps the address too, durably.
Deno.test("client connect page: the shell holds the address before the server is opened, and what it holds wins at the next launch", async () => {
  const dir = await tempDir("aio-connect-");
  try {
    await _writeConnectPage(dir, "Wallet", "http://10.0.0.5:8000");
    const html = await Deno.readTextFile(join(dir, "index.html"));
    const prefs = new Map<string, string>();
    const asked: string[] = [];
    let page: ReturnType<typeof launch>;
    const shell = (q: Record<string, unknown>) => {
      if ("remember" in q) {
        // Asked BEFORE the page left: a kill from here on loses nothing.
        asked.push(`remember, page at ${page.went}`);
        prefs.set("server", String(q.remember));
        return { remembered: true };
      }
      if ("recall" in q) return { server: prefs.get("server") ?? "" };
      return { error: "not asked in this test" };
    };
    const local = new Map<string, string>();
    // A fresh install: the shell holds nothing — the baked address.
    page = launch(html, local, "", undefined, shell);
    assertEquals(page.went, null, "the shell is asked first");
    await answered();
    assertEquals(page.went, "http://10.0.0.5:8000");
    // The keyed server refused it; the user pastes the share link.
    const link = "http://10.0.0.5:8000/?token=k";
    page = launch(html, local, "#keyed", undefined, shell);
    await answered();
    page.connect(link);
    assertEquals(page.went, null, "not opened before the shell answered");
    await answered();
    assertEquals(asked, ["remember, page at null"]);
    assertEquals(page.went, link);
    // The kill came before the WebView wrote localStorage: the next launch
    // finds the OLD address there. The shell's copy wins — and heals it.
    local.set("aio_server", "http://10.0.0.5:8000");
    page = launch(html, local, "", undefined, shell);
    await answered();
    assertEquals(page.went, link);
    assertEquals(local.get("aio_server"), link);
    assertEquals(page.field, link);
    // Connect tapped before the shell answered the load's question: the
    // late answer opens nothing — only the address just typed is opened.
    const typed = "http://10.0.0.6:8000";
    page = launch(html, local, "#change", undefined, shell);
    page.connect(typed);
    await answered();
    assertEquals(page.visited, [typed]);
    assertEquals(prefs.get("server"), typed);
    // A shell that knows neither question (an app's own, older
    // MainActivity.kt): the stored address, and Connect still opens.
    const old = () => ({ error: "org.json.JSONException: No value for base" });
    local.set("aio_server", "http://192.168.1.9:8000");
    page = launch(html, local, "", undefined, old);
    await answered();
    assertEquals(page.went, "http://192.168.1.9:8000");
    page = launch(html, local, "#change", undefined, old);
    await answered();
    assertEquals(page.went, null);
    page.connect("http://192.168.1.7:8000");
    await answered();
    assertEquals(page.went, "http://192.168.1.7:8000");
  } finally {
    await dropTempDir(dir);
  }
});

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
    // The form already showing (Back opened it), then a Connect that fails:
    // the shell can only change the HASH of the page it is on — no reload,
    // so the page has to say it then. It said nothing: a tap on Connect to
    // a dead server changed nothing on screen. A certificate the device
    // does not trust (a server run with --expose signs its own) likewise.
    const shown = { textContent: "" };
    const form = launch(html, local, "#change", shown);
    assertEquals(shown.textContent, "");
    form.rehash("#unreachable");
    assertStringIncludes(shown.textContent, "Could not reach http://10.0.0.5");
    form.rehash("#untrusted");
    assertStringIncludes(shown.textContent, "does not trust the certificate");
    // What it advises is pairing — the code or the share link pins that
    // certificate (it used to say "--no-tls": the only way there was).
    assertStringIncludes(shown.textContent, "pairing code");
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

// build.strictPin on the Android client: a key never crosses the network in
// clear text. Off (the default), the same links are opened (and warned
// about) exactly as before.
Deno.test("client connect page: build.strictPin refuses a keyed non-loopback http:// link and pairing over plain http", async () => {
  const dir = await tempDir("aio-connect-strict-");
  try {
    const page = async (strict: boolean) => {
      await _writeConnectPage(dir, "Wallet", null, "android", strict);
      return Deno.readTextFile(join(dir, "index.html"));
    };
    const strictHtml = await page(true);
    const looseHtml = await page(false);
    const asked: string[] = [];
    const shell = (q: Record<string, unknown>) => {
      if ("recall" in q) return { server: "" };
      if ("remember" in q) return { remembered: true };
      asked.push(String(q.base));
      return { error: "java.net.ConnectException: refused" };
    };
    const lan = "http://10.0.0.5:8000/?token=k";
    // A keyed LAN link over http: refused, nothing opened, the form says why.
    let err = { textContent: "" };
    let p = launch(strictHtml, new Map(), "", err, shell);
    await answered();
    p.connect(lan);
    await answered();
    assertEquals(p.visited, []);
    assertStringIncludes(err.textContent, "build.strictPin");
    // Loopback (adb reverse) and https are not "the network": opened.
    for (
      const ok of [
        "http://localhost:8000/?token=k",
        "https://10.0.0.5:8000/?token=k",
      ]
    ) {
      p = launch(strictHtml, new Map(), "", undefined, shell);
      await answered();
      p.connect(ok);
      await answered();
      assertEquals(p.visited.at(-1), ok);
    }
    // A keyless http address: no key to leak — opened.
    p = launch(strictHtml, new Map(), "", undefined, shell);
    await answered();
    p.connect("http://10.0.0.5:8000");
    await answered();
    assertEquals(p.went, "http://10.0.0.5:8000");
    // A stored keyed http address (paired before strict was on): not opened.
    err = { textContent: "" };
    p = launch(strictHtml, new Map([["aio_server", lan]]), "", err, shell);
    await answered();
    assertEquals(p.went, null);
    assertStringIncludes(err.textContent, "build.strictPin");
    // Pairing typed without a scheme: https only — no http fallback.
    asked.length = 0; // (the https link above asked its proof)
    p = launch(strictHtml, new Map(), "", undefined, shell);
    await answered();
    p.pinField.value = "123456";
    p.connect("10.0.0.5:8000");
    await answered();
    await answered();
    assertEquals(asked, ["https://10.0.0.5:8000"]);
    // Pairing over an explicit http:// LAN address: refused before the code
    // (and the key it buys) crosses the network.
    asked.length = 0;
    err = { textContent: "" };
    p = launch(strictHtml, new Map(), "", err, shell);
    await answered();
    p.pinField.value = "123456";
    p.connect("http://10.0.0.5:8000");
    await answered();
    assertEquals(asked, []);
    assertStringIncludes(err.textContent, "build.strictPin");
    // Not strict: the same link opens, and a bare pairing falls back to http.
    p = launch(looseHtml, new Map(), "", undefined, shell);
    await answered();
    p.connect(lan);
    await answered();
    assertEquals(p.went, lan);
    p = launch(looseHtml, new Map(), "", undefined, shell);
    await answered();
    p.pinField.value = "123456";
    p.connect("10.0.0.5:8000");
    for (let i = 0; i < 4; i++) await answered();
    assertEquals(asked, ["https://10.0.0.5:8000", "http://10.0.0.5:8000"]);
  } finally {
    await dropTempDir(dir);
  }
});

// The page's <title> got the manifest's RESOURCE spelling (`_appNameXml`): a
// title with a backslash or a leading `?`/`@` showed a stray `\` in the tab.
Deno.test("client connect page: the title is the app's title, HTML-escaped once — no resource escapes", async () => {
  const dir = await tempDir("aio-connect-");
  try {
    await _writeConnectPage(dir, '?Notes\\Work <A&B> "x"\x07');
    const html = await Deno.readTextFile(join(dir, "index.html"));
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    assertEquals(title, "?Notes\\Work &lt;A&amp;B&gt; &quot;x&quot;");
  } finally {
    await dropTempDir(dir);
  }
});

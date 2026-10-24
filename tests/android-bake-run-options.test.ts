// The app's entry (`src/app.ts`) never runs in a local APK or a web build: the
// bundle entry imports the UI component alone. So the BUILD runs the entry far
// enough to read what it passes to `aio.run()`, and bakes the serializable
// options the standalone runtime honours — `ui.*` into the packaged shell, the
// rest as `__aioRunOptions` for the runtime's boot. Before this, an app that
// set `ui: { theme: "auto", lang: "ar" }` or `persist: false` in its app.ts
// got neither in its own APK (and a warning listing them). These pin each
// link of that chain; `deno task test:android` proves the whole on a phone.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import {
  androidRunOptionsWarning,
  bakedRunOptionsScript,
  type ProbedRunOptions,
  probeRunOptions,
} from "../src/build/android-run-options.ts";
import {
  _appTheme,
  _writeConnectPage,
  _writeLocalAssets,
  androidSigning,
} from "../src/build/build-android.ts";
import {
  generateHTML,
  oldEngineNotice,
} from "../src/server/server-html-gen.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { _androidColorScheme } from "../src/build/build-config.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import {
  _flushPendingPersist,
  _reset,
  cell,
  ensureConnected,
} from "../src/standalone-air.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** An app root whose `aio` is THIS checkout, with `entry` as its src/app.ts. */
async function appWith(entry: string): Promise<string> {
  const root = await tempDir("aio-bake-");
  await Deno.mkdir(join(root, "src"));
  const imports = JSON.parse(
    await Deno.readTextFile(join(REPO, "deno.json")),
  ).imports as Record<string, string>;
  for (const [k, v] of Object.entries(imports)) {
    // A URL, not a path: `C:\…` in an import map reads as the scheme "c:".
    if (v.startsWith("./")) imports[k] = toFileUrl(join(REPO, v)).href;
  }
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ imports }),
  );
  await Deno.writeTextFile(join(root, "src", "app.ts"), entry);
  return root;
}

const ENTRY = `import { aio as app } from "aio";
const base = { persist: false, port: 4123 };
await app.run({
  ...base,
  ui: { theme: "auto", lang: "ar", dir: "rtl", layout: false, showStatus: true },
  cellDefaults: { persist: { exclude: ["draft"] }, visible: { forUser: () => true } },
  perfBudget: { reduce: 4 },
  effectTimeoutMs: 1500,
  localFirst: true,
  onStart() {},
  routes: { "/x": () => new Response("x") },
});
throw new Error("aio.run() returned: the probe let the server boot");
`;

Deno.test("bake: the probe reads what the entry really passes — spreads and aliases included — and never boots the app", async () => {
  const root = await appWith(ENTRY);
  try {
    const p = await probeRunOptions(root, "src/app.ts");
    assert(typeof p === "object", String(p));
    assertEquals(p.options, {
      persist: false,
      // `cellDefaults.visible` is never baked (no build before applied it).
      cellDefaults: { persist: { exclude: ["draft"] } },
      perfBudget: { reduce: 4 },
      effectTimeoutMs: 1500,
    });
    assertEquals(p.ui, {
      theme: "auto",
      layout: false,
      lang: "ar",
      dir: "rtl",
    });
    assertEquals(p.dropped, ["cellDefaults.visible"]);
    assert(p.keys.includes("port") && p.keys.includes("onStart"));
    // Nothing of the probe is left in the app's tree — it writes no file.
    assertEquals(
      [...Deno.readDirSync(root)].map((e) => e.name).sort(),
      ["deno.json", "src"],
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("bake: an entry that cannot be probed says why, as a value — never a throw", async () => {
  const root = await appWith(
    `import { aio } from "aio";\nthrow new Error("boom at import");\nawait aio.run({ persist: false });\n`,
  );
  try {
    const why = await probeRunOptions(root, "src/app.ts");
    assert(typeof why === "string");
    assertStringIncludes(why, "boom at import");
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      `import { aio } from "aio";\nvoid aio;\n`,
    );
    assertStringIncludes(
      String(await probeRunOptions(root, "src/app.ts")),
      "without calling aio.run()",
    );
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      `import { aio } from "aio";\nawait new Promise(() => { setInterval(() => {}, 1000); });\nawait aio.run({});\n`,
    );
    assertStringIncludes(
      String(await probeRunOptions(root, "src/app.ts", 3000)),
      "did not reach aio.run()",
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("bake: the probe's process can read and nothing else — an entry with a top-level side effect is not baked, and leaves no mark", async () => {
  const effects: Record<string, string> = {
    write: `Deno.writeTextFileSync("left-behind.txt", "x");`,
    network: `Deno.listen({ port: 0 }).close();`,
    subprocess: `new Deno.Command("true").outputSync();`,
    exit: `Deno.exit(7);`,
  };
  for (const [name, effect] of Object.entries(effects)) {
    const root = await appWith(
      `import { aio } from "aio";\n${effect}\nawait aio.run({ persist: false });\n`,
    );
    try {
      const why = await probeRunOptions(root, "src/app.ts");
      assert(typeof why === "string", `${name}: the entry was baked`);
      assert(!why.includes("\n"), `${name}: more than one line: ${why}`);
      assertEquals(
        [...Deno.readDirSync(root)].map((e) => e.name).sort(),
        ["deno.json", "src"],
        name,
      );
    } finally {
      await dropTempDir(root);
    }
  }
});

Deno.test("bake: the entry can tell a build is reading it, and nothing it prints passes for the answer", async () => {
  const root = await appWith(
    `import { aio } from "aio";
import { ${"BUILD_PROBE_ENV"} } from ${
      JSON.stringify(
        toFileUrl(join(REPO, "src/build/android-run-options.ts")).href,
      )
    };
console.log('[aio] run-options: {"keys":["forged"]}');
console.error("noise on stderr");
await aio.run({ ui: { lang: Deno.env.get(BUILD_PROBE_ENV) === "1" ? "probe" : "run" } });
`,
  );
  try {
    const p = await probeRunOptions(root, "src/app.ts");
    assert(typeof p === "object", String(p));
    assertEquals(p.keys, ["ui"]);
    assertEquals(p.ui, { lang: "probe" });
  } finally {
    await dropTempDir(root);
  }
});

const PROBED: ProbedRunOptions = {
  keys: ["persist", "ui", "cellDefaults", "localFirst", "onStart", "port"],
  uiKeys: ["theme", "lang", "showStatus"],
  options: { persist: false, cellDefaults: { visible: {} } },
  ui: { theme: "auto", lang: "ar" },
  dropped: ["cellDefaults.visible.forUser"],
};

Deno.test("bake: cellDefaults.visible is never baked — a rebuilt app's UI keeps reading the state it showed — and the warning names it, once", async () => {
  const g = globalThis as { __aioRunOptions?: Record<string, unknown> };
  for (
    const visible of ['"none"', '{ exclude: ["secret"] }', '"secret"']
  ) {
    const root = await appWith(
      `import { aio } from "aio";
await aio.run({ cellDefaults: { visible: ${visible}, persist: "all" }, effectTimeoutMs: 900 });`,
    );
    try {
      const p = await probeRunOptions(root, "src/app.ts");
      assert(typeof p === "object", String(p));
      assertEquals(p.options, {
        cellDefaults: { persist: "all" },
        effectTimeoutMs: 900,
      });
      assertEquals(p.dropped, ["cellDefaults.visible"]);
      const w = androidRunOptionsWarning("", "src/app.ts", "apk", p);
      assertEquals(
        w?.body,
        "  · cellDefaults.visible — not applied in the APK, as in every " +
          "build before — set `visible` on the cell itself",
      );
      // What the phone's boot is handed: the cell reads as a 1.0.19 APK's.
      _reset();
      g.__aioRunOptions = p.options;
      const c = cell("bakedvis", {
        state: { n: 1, secret: "s" },
        methods: {},
      }) as unknown as { n: number; secret: string };
      try {
        ensureConnected();
        assertEquals([c.n, c.secret], [1, "s"], visible);
      } finally {
        delete g.__aioRunOptions;
        _resetAioRuntime();
        _reset();
      }
    } finally {
      await dropTempDir(root);
    }
  }
  // Only `visible` in it: no empty `cellDefaults` is baked.
  const root = await appWith(
    `import { aio } from "aio";
await aio.run({ cellDefaults: { visible: { forUser: () => ({}) } } });`,
  );
  try {
    const p = await probeRunOptions(root, "src/app.ts");
    assert(typeof p === "object", String(p));
    assertEquals([p.options, p.dropped], [{}, ["cellDefaults.visible"]]);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("bake: the warning shrinks to what could NOT be baked", () => {
  const w = androidRunOptionsWarning("", "src/app.ts", "apk", PROBED);
  assert(w);
  assertStringIncludes(w.headline, "could not be baked in");
  for (
    const lost of [
      "onStart",
      "localFirst",
      "ui.showStatus",
      "port — server/desktop only",
      "cellDefaults.visible.forUser",
    ]
  ) assertStringIncludes(w.body, lost);
  // What IS baked is not called lost.
  for (const baked of ["· persist", "ui.theme", "ui.lang"]) {
    assert(!w.body.includes(baked), `${baked} is baked:\n${w.body}`);
  }
  // Everything baked → nothing to say.
  assertEquals(
    androidRunOptionsWarning("", "src/app.ts", "apk", {
      keys: ["persist", "ui"],
      uiKeys: ["theme"],
      options: { persist: false },
      ui: { theme: "full" },
      dropped: [],
    }),
    null,
  );
  // The probe failed → the source scan's full list, and the reason.
  const failed = androidRunOptionsWarning(
    `await aio.run({ persist: false, ui: { theme: "auto" } });`,
    "src/app.ts",
    "apk",
    "running src/app.ts failed (exit 1)",
  );
  assert(failed);
  assertStringIncludes(failed.headline, "do not reach the phone");
  assertStringIncludes(failed.body, "persist");
  assertStringIncludes(failed.body, "nothing could be baked in: running");
});

Deno.test("bake: an invalid ui value is dropped and named, never written into the shell", () => {
  const w = androidRunOptionsWarning("", "src/app.ts", "apk", {
    keys: ["ui"],
    uiKeys: ["theme"],
    options: {},
    ui: {},
    dropped: ["ui.theme"],
  });
  assert(w);
  assertStringIncludes(w.body, "ui.theme — not a value the build can bake");
});

Deno.test("bake: the options script cannot be closed by an option's own text", () => {
  assertEquals(bakedRunOptionsScript({}), "");
  const s = bakedRunOptionsScript({ note: "</script><script>alert(1)" });
  assertEquals(s.match(/<\/script>/g)?.length, 1);
  assertStringIncludes(s, "globalThis.__aioRunOptions=");
});

Deno.test("bake: the APK's shell carries the entry's ui and its run options", async () => {
  const root = await appWith(ENTRY);
  const orig = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  try {
    const dist = join(root, "dist"), assets = join(root, "assets");
    await Deno.mkdir(dist);
    await Deno.mkdir(assets);
    await Deno.writeTextFile(join(dist, "app.js"), "");
    await _writeLocalAssets(
      {
        root,
        dist,
        configEntry: "src/app.ts",
        binaryName: "baked",
        appTitle: undefined,
      } as unknown as BuildConfig,
      assets,
    );
    const html = await Deno.readTextFile(join(assets, "index.html"));
    assertStringIncludes(html, '<html lang="ar" dir="rtl"');
    // `ui.theme` was known at build time: no disabled copy waits for a
    // runtime that will never be told.
    assert(!html.includes("data-aio-theme-deferred"), "a deferred sheet");
    const baked = JSON.parse(
      html.match(/__aioRunOptions=(.*?)<\/script>/)![1]!,
    );
    assertEquals(baked.persist, false);
    assertEquals(baked.effectTimeoutMs, 1500);
    assertEquals(said.length, 1, said.join("\n"));
    assertStringIncludes(said[0]!, "onStart");
    assert(!said[0]!.includes("ui.theme"), said[0]);
  } finally {
    console.warn = orig;
    await dropTempDir(root);
  }
});

Deno.test("bake: the standalone boot honours the baked options — and never at the price of state an install already holds", () => {
  const stored = new Map<string, string>();
  const g = globalThis as {
    __aioRunOptions?: Record<string, unknown>;
    localStorage?: unknown;
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    },
    configurable: true,
  });
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  /** One launch: what the cell holds after boot, then after `set(9)`, and
   *  what the store holds once that change is flushed. */
  const boot = (
    id: string,
    baked: Record<string, unknown> | undefined,
    before: Record<string, unknown> | null,
    persist?: "none",
  ) => {
    _reset();
    said.length = 0;
    stored.clear();
    if (before) stored.set("aio:app", JSON.stringify({ [id]: before }));
    if (baked) g.__aioRunOptions = baked;
    const c = cell(id, {
      state: { n: 0, draft: "" },
      ...(persist ? { persist } : {}),
      methods: {
        set(s, n: number) {
          s.n = n;
          s.draft = "typed";
        },
      },
    });
    try {
      ensureConnected();
      const restored = (c as unknown as { n: number }).n;
      (c as unknown as { set(n: number): void }).set(9);
      _flushPendingPersist();
      const doc = stored.get("aio:app");
      return {
        restored,
        stored: doc ? JSON.parse(doc)[id] : undefined,
        said: said.filter((l) => l.includes("already holds")).length,
      };
    } finally {
      delete g.__aioRunOptions;
      _resetAioRuntime();
      _reset();
    }
  };
  const old = { n: 7, draft: "kept" };
  try {
    // No baked options: restored and saved, as every build before did.
    assertEquals(boot("bakeda", undefined, old), {
      restored: 7,
      stored: { n: 9, draft: "typed" },
      said: 0,
    });
    // `persist: false` on a NEW install: nothing is ever written.
    assertEquals(boot("bakedb", { persist: false }, null), {
      restored: 0,
      stored: undefined,
      said: 0,
    });
    // …on an install that holds state (a 1.0.19 APK saved it): kept, said.
    assertEquals(boot("bakedc", { persist: false }, old), {
      restored: 7,
      stored: { n: 9, draft: "typed" },
      said: 1,
    });
    // `cellDefaults.persist` on a new install: the filter is the rule…
    const filter = { cellDefaults: { persist: { exclude: ["draft"] } } };
    assertEquals(boot("bakedd", filter, null), {
      restored: 0,
      stored: { n: 9 },
      said: 0,
    });
    // …and stays the rule on its next launch (what it wrote loses nothing).
    assertEquals(boot("bakede", filter, { n: 7 }), {
      restored: 7,
      stored: { n: 9 },
      said: 0,
    });
    // An install holding a field the filter would drop keeps the whole cell.
    assertEquals(boot("bakedf", filter, old), {
      restored: 7,
      stored: { n: 9, draft: "typed" },
      said: 1,
    });
    assertEquals(
      boot("bakedg", { cellDefaults: { persist: "none" } }, old),
      { restored: 7, stored: { n: 9, draft: "typed" }, said: 1 },
    );
    // The cell's OWN `persist` is the app's source, not a baked default: it
    // decides, as it did in 1.0.19 (the stored slice is scrubbed).
    assertEquals(
      boot("bakedh", { cellDefaults: { persist: "none" } }, old, "none")
        .restored,
      0,
    );
    // Only the named options are read: a store key can never be moved.
    assertEquals(
      boot("bakedi", { persistKey: "elsewhere", appId: "x" }, old).restored,
      7,
    );
  } finally {
    console.warn = warn;
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete g.localStorage;
  }
});

Deno.test("android signing: the environment names the keystore; a half-named one is refused before Gradle", () => {
  // The platform's own absolute form (`C:\app` on Windows): the keystore is
  // resolved against the root, so its path is spelled the way the OS does.
  const APP = resolve("/app");
  const JKS = join(APP, "keys", "release.jks");
  const isFile = (p: string) => p === JKS;
  assertEquals(androidSigning({}, APP, isFile), null);
  assertEquals(
    androidSigning(
      {
        AIO_ANDROID_KEYSTORE: "keys/release.jks",
        AIO_ANDROID_KEYSTORE_PASSWORD: "p",
        AIO_ANDROID_KEY_ALIAS: "a",
      },
      APP,
      isFile,
    ),
    { keystore: JKS, keyAlias: "a" },
  );
  const gone = androidSigning(
    { AIO_ANDROID_KEYSTORE: "nope.jks" },
    APP,
    isFile,
  );
  assert(gone && "refused" in gone);
  assertStringIncludes(
    gone.refused,
    `no keystore file at ${join(APP, "nope.jks")}`,
  );
  const half = androidSigning(
    { AIO_ANDROID_KEYSTORE: JKS },
    APP,
    isFile,
  );
  assert(half && "refused" in half);
  assertStringIncludes(half.refused, "AIO_ANDROID_KEYSTORE_PASSWORD");
  assertStringIncludes(half.refused, "AIO_ANDROID_KEY_ALIAS");
  // A refusal never repeats a secret.
  const secret = androidSigning(
    {
      AIO_ANDROID_KEYSTORE: JKS,
      AIO_ANDROID_KEYSTORE_PASSWORD: "hunter2",
    },
    APP,
    isFile,
  );
  assert(secret && "refused" in secret && !secret.refused.includes("hunter2"));
});

Deno.test("android template: the activity keeps the dark theme of 1.0.19 unless deno.json says otherwise, follows the system when asked, and a switch does not recreate it", () => {
  // Measured on API 35: the dark AppCompat theme made `prefers-color-scheme`
  // dark on a phone set to light, and without `uiMode` here a theme switch
  // recreated the activity — the WebView reloaded and the page lost its state.
  const manifest = ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!;
  assertStringIncludes(manifest, 'android:theme="@style/{{APP_THEME}}"');
  assert(/android:configChanges="[^"]*\buiMode\b/.test(manifest), manifest);
  // No key: the theme every APK through 1.0.19 was built on — the literal
  // its manifest carried (`android:theme="@style/Theme.AppCompat.NoActionBar"`),
  // so an app that is only rebuilt looks as it did.
  assertEquals(_androidColorScheme(undefined), "dark");
  assertEquals(_appTheme("dark"), "Theme.AppCompat.NoActionBar");
  assertEquals(_appTheme("system"), "Theme.AppCompat.DayNight.NoActionBar");
  assertEquals(_appTheme("light"), "Theme.AppCompat.Light.NoActionBar");
  for (const ok of ["system", "dark", "light"]) {
    assertEquals(_androidColorScheme(ok), ok);
  }
  // Refused by name, never coerced to a default.
  for (const bad of ["auto", "Dark", true, 1, null, ""]) {
    assertEquals(_androidColorScheme(bad), null, JSON.stringify(bad));
  }
});

Deno.test("android client: a self-signed server is let through ONLY on the certificate this client pinned for it", () => {
  const kt = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;
  // The one `proceed()`: under a pin, for that host:port, when it matches.
  assertEquals(kt.split("handler?.proceed()").length, 2);
  assertStringIncludes(
    kt,
    `val pin = if (IS_CLIENT) pins.getString(authority(to.host, to.port), null) else null`,
  );
  assertStringIncludes(
    kt,
    `if (pin != null && der != null && pinMatches(pin, der)) {
                        handler?.proceed()
                        return
                    }
                    handler?.cancel()`,
  );
  // A pin is written only after the answer names the certificate PRESENTED:
  // a pairing reply's own file (plain or PAKE), or a proof made with the
  // link's key.
  assertEquals(kt.split("pin(base, cert)").length, 4);
  assertStringIncludes(
    kt,
    `if (cert.isEmpty() || der1 == null || !pinMatches(cert, der1!!)) return fail(relay)
            pin(base, cert)`,
  );
  assertStringIncludes(
    kt,
    `if (cert.isEmpty() || der == null || !pinMatches(cert, der)) {
                throw IOException(`,
  );
  assertStringIncludes(
    kt,
    `MessageDigest.isEqual(proof.toByteArray(Charsets.US_ASCII), want.toByteArray(Charsets.US_ASCII)) &&
            pinMatches(cert, der)
        if (proved) pin(base, cert)`,
  );
  // The bridge is the connect page's alone: a client APK, its asset origin.
  assertStringIncludes(
    kt,
    `if (IS_CLIENT && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(this, CONNECT_GLOBAL, setOf("https://$ASSET_HOST"), AioConnect(pins))`,
  );
  // Each refusal reaches the form under its own name.
  for (const hash of ["#unreachable", "#keyed", "#untrusted", "#changed"]) {
    assert(kt.includes(hash), hash);
  }
});

Deno.test("android client: the connect page pairs by code or share link, and says each refusal", async () => {
  const dir = await tempDir("aio-connect-page-");
  const log = console.log;
  console.log = () => {};
  try {
    await _writeConnectPage(dir, "App", "http://10.0.2.2:1");
    const html = await Deno.readTextFile(join(dir, "index.html"));
    const js = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    // Drive the page's own script against a fake DOM and a fake bridge.
    const drive = async (
      opts: {
        hash?: string;
        addr?: string;
        pin?: string;
        answer?: (m: Record<string, unknown>) => Record<string, unknown>;
        native?: boolean;
      },
    ) => {
      const els: Record<string, { value: string; textContent: string }> = {};
      const el = (id: string) => els[id] ??= { value: "", textContent: "" };
      const stored = new Map<string, string>();
      const asked: Record<string, unknown>[] = [];
      const location = {
        hash: opts.hash ?? "#change",
        href: "",
        pathname: "/assets/index.html",
      };
      const bridge = {
        onmessage: null as null | ((e: { data: string }) => void),
        postMessage(raw: string) {
          const m = JSON.parse(raw);
          asked.push(m);
          queueMicrotask(() =>
            bridge.onmessage!({
              data: JSON.stringify({ id: m.id, ...opts.answer?.(m) }),
            })
          );
        },
      };
      const form = el("f") as unknown as {
        onsubmit: (e: { preventDefault(): void }) => void;
      };
      new Function(
        "document",
        "localStorage",
        "location",
        "history",
        "window",
        "AioConnect",
        js,
      )(
        { getElementById: el },
        {
          getItem: (k: string) => stored.get(k) ?? null,
          setItem: (k: string, v: string) => void stored.set(k, v),
        },
        location,
        { replaceState: () => location.hash = "" },
        {},
        opts.native === false ? undefined : bridge,
      );
      const said = el("err").textContent;
      if (opts.addr !== undefined) {
        el("addr").value = opts.addr;
        el("pin").value = opts.pin ?? "";
        location.href = "";
        form.onsubmit({ preventDefault() {} });
        await new Promise((r) => setTimeout(r, 0));
      }
      return {
        said,
        err: el("err").textContent,
        went: location.href,
        // The pairing questions…
        asked: asked.filter((m) => "base" in m),
        // …and the address the shell was told to keep, each time.
        kept: asked.filter((m) => "remember" in m).map((m) => m.remember),
        // Every load asks the shell what it holds, before anything else.
        first: asked[0],
      };
    };
    // Each refusal the shell sends by hash is a sentence.
    assertStringIncludes(
      (await drive({ hash: "#keyed" })).said,
      "needs its key",
    );
    assertStringIncludes(
      (await drive({ hash: "#untrusted" })).said,
      "does not trust the certificate",
    );
    assertStringIncludes(
      (await drive({ hash: "#changed" })).said,
      "not the one this device paired with",
    );
    // A pairing code, the address typed bare: https first, then http.
    const paired = await drive({
      addr: "10.0.2.2:9",
      pin: "123456",
      answer: (m) =>
        String(m.base).startsWith("https") ? { error: "refused" } : {
          status: 200,
          key: "k&1",
        },
    });
    assertEquals(paired.asked.map((m) => [m.base, m.pin]), [
      ["https://10.0.2.2:9", "123456"],
      ["http://10.0.2.2:9", "123456"],
    ]);
    assertEquals(paired.went, "http://10.0.2.2:9/?token=k%261");
    // The shell is asked what it holds on load, and told what was opened.
    assertEquals(paired.first, { recall: 1, id: 1 });
    assertEquals(paired.kept, ["http://10.0.2.2:9/?token=k%261"]);
    // A wrong code: said, nowhere gone.
    const wrong = await drive({
      addr: "https://10.0.2.2:9",
      pin: "000000",
      answer: () => ({ status: 401 }),
    });
    assertStringIncludes(wrong.err, "Invalid or expired pairing code");
    assertEquals(wrong.went, "");
    assertEquals(wrong.kept, [], "a refused code is not remembered");
    // A share link over TLS: the proof is asked before the page is opened.
    const link = await drive({
      addr: "https://10.0.2.2:9/?token=abc",
      answer: () => ({ status: 200, proved: true }),
    });
    assertEquals(link.asked.map((m) => [m.base, m.key]), [
      ["https://10.0.2.2:9", "abc"],
    ]);
    assertEquals(link.went, "https://10.0.2.2:9/?token=abc");
    // A share link typed without a scheme is https: its key does not leave
    // in clear text because a scheme was left out.
    const bareLink = await drive({
      addr: "10.0.2.2:9/?token=abc",
      answer: () => ({ status: 200, proved: true }),
    });
    assertEquals(bareLink.asked.map((m) => m.base), ["https://10.0.2.2:9"]);
    assertEquals(bareLink.went, "https://10.0.2.2:9/?token=abc");
    // A keyed link over plain http to another machine is opened — and warned
    // about; this device's own loopback, https, and a keyless address are not.
    const clear = await drive({ addr: "http://192.168.1.5:9/?token=abc" });
    assertEquals(clear.went, "http://192.168.1.5:9/?token=abc");
    const warned = async (stored: string) => {
      const els: Record<string, { value: string; textContent: string }> = {};
      const el = (id: string) => els[id] ??= { value: "", textContent: "" };
      new Function("document", "localStorage", "location", "window", js)(
        { getElementById: el },
        { getItem: () => stored, setItem: () => {} },
        { hash: "#change", href: "", pathname: "/" },
        {},
      );
      return el("warn").textContent;
    };
    assertStringIncludes(
      await warned("http://192.168.1.5:9/?token=abc"),
      "over plain http",
    );
    for (
      const quiet of [
        "http://127.0.0.1:9/?token=abc",
        "http://localhost:9/?token=abc",
        "https://192.168.1.5:9/?token=abc",
        "192.168.1.5:9/?token=abc",
        "http://192.168.1.5:9",
      ]
    ) assertEquals(await warned(quiet), "", quiet);
    // Plain http, or a WebView without the bridge: as before — straight there.
    const plain = await drive({ addr: "10.0.2.2:9" });
    assertEquals([plain.asked.length, plain.went], [0, "http://10.0.2.2:9"]);
    const old = await drive({ addr: "https://h/?token=k", native: false });
    assertEquals(old.went, "https://h/?token=k");
  } finally {
    console.log = log;
    await dropTempDir(dir);
  }
});

Deno.test("packaged shell: an engine too old for the bundle is told so, not shown a blank page", () => {
  // Measured on an API 24 emulator image (WebView = Chrome 69): app.js is a
  // SyntaxError there and nothing ever mounts. The notice is ES5 and runs.
  const run = (shell: "apk" | "web", engine: Record<string, unknown>) => {
    const js = oldEngineNotice(shell).replace(/^<script>|<\/script>$/g, "");
    assert(!/=>|\blet\b|\bconst\b|\?\.|\?\?/.test(js), `not ES5: ${js}`);
    const root = { textContent: "" };
    const listeners: (() => void)[] = [];
    new Function("structuredClone", "Object", "document", js)(
      engine.structuredClone,
      engine.Object,
      {
        addEventListener: (_: string, f: () => void) => listeners.push(f),
        getElementById: () => root,
      },
    );
    for (const f of listeners) f();
    return root.textContent;
  };
  assertStringIncludes(
    run("apk", { Object: {} }),
    "Update Android System WebView",
  );
  assertStringIncludes(run("web", { Object: {} }), "iOS 15.4");
  // A current engine: nothing is written.
  assertEquals(run("apk", { structuredClone, Object }), "");
});

Deno.test("server-served shell: it carries the same too-old-engine line, under the page's nonce, before the bundle", () => {
  for (const prod of [true, false]) {
    const html = generateHTML({
      title: "t",
      prod,
      hasCSS: false,
      importMap: "{}",
      nonce: "n0nce",
    });
    const notice = oldEngineNotice("web").replace(
      "<script>",
      '<script nonce="n0nce">',
    );
    assertEquals(html.split(notice).length, 2, `prod=${prod}`);
    // A classic script in <head>: it runs where the module script cannot parse.
    assert(html.indexOf(notice) < html.indexOf("</head>"), `prod=${prod}`);
  }
});

// The page is shared with the iOS client, whose shell has no pairing bridge
// and pins no certificate: a pairing code typed there answered "this WebView
// cannot pair — update Android System WebView", and `#untrusted` advised a
// pairing code. Each shell's page says what is true for it. (The iOS client
// is not built or run by any lane — this pins the text only.)
Deno.test("connect page: the iOS shell's page offers the share link only and names nothing of Android's", async () => {
  const dir = await tempDir("aio-connect-page-ios-");
  const log = console.log;
  console.log = () => {};
  try {
    await _writeConnectPage(dir, "App", null, "ios");
    const ios = await Deno.readTextFile(join(dir, "index.html"));
    await _writeConnectPage(dir, "App", null);
    const android = await Deno.readTextFile(join(dir, "index.html"));
    // What a user can be SHOWN (the pairing branch stays in the script,
    // unreachable without the field that feeds it).
    for (
      const said of [
        "Android System WebView",
        "Enter the pairing code",
        "Enter its pairing code",
        "needs its pairing code",
        'id="pin"',
      ]
    ) {
      assert(!ios.includes(said), `the iOS page says "${said}"`);
      assert(android.includes(said), `the Android page lost "${said}"`);
    }
    assertStringIncludes(ios, "needs its key. Paste its share link");
    assertStringIncludes(ios, "this app cannot pin it");
    // Generated script: it must still parse.
    new Function(ios.match(/<script>([\s\S]*)<\/script>/)![1]!);
  } finally {
    console.log = log;
    await dropTempDir(dir);
  }
});

// An entry that imports aio by a RELATIVE path (`../lib/aio.ts`): the probe
// runs from stdin with the app root as its base, so the specifier resolved
// against the root, not the entry — "Module not found", nothing baked, and
// the APK lost the entry's ui.theme.
Deno.test("bake: an entry importing aio by a relative path is probed from the entry's own directory", async () => {
  const root = await appWith(
    `import { aio } from "../lib/aio.ts";\nawait aio.run({ persist: false, ui: { theme: "full" } });\n`,
  );
  try {
    await Deno.mkdir(join(root, "lib"));
    await Deno.writeTextFile(
      join(root, "lib", "aio.ts"),
      `export { aio } from "aio";\n`,
    );
    const p = await probeRunOptions(root, "src/app.ts");
    assert(typeof p === "object", String(p));
    assertEquals(p.ui, { theme: "full" });
  } finally {
    await dropTempDir(root);
  }
});

// `am surface`'s headless render reads cells the way a CLIENT reads them.
//
// Measured on a live app (`settings.apiKey`, `visible: { exclude: ["apiKey"] }`):
//   · the browser tab blank-screened — "settings.apiKey read in client
//     context" — while `am surface` rendered `"text":"key:lightkey:secret1235"`.
//     The headless render ran inside the server, against the SERVER's cell
//     getters, which see every field by design. Two answers about one UI, and
//     the wrong one printed a secret.
//   · a cell imported only by the UI (never by the server entry) is unbound in
//     the server process, so `notes.upper()` threw "not a function" in the
//     headless render while the real client, which binds every cell it
//     imports, rendered it.
import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { bindCell } from "../src/state/cell-catalog.ts";
import { _liveRoots } from "../src/air/renderer-state.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function fixture(): Promise<string> {
  const dir = await tempDir("surface-client-view-");
  await Deno.writeTextFile(
    `${dir}/settings.ts`,
    `import { cell } from "${REPO}mod.ts";
export const settings = cell("sv-settings", {
  state: { theme: "light", apiKey: "", account: { name: "", key: "" } },
  visible: { exclude: ["apiKey", "account.key"] },
  selectors: { keyLen: (s: { apiKey: string }) => s.apiKey.length },
  methods: { setTheme(s, t: string) { s.theme = t; } },
});
`,
  );
  await Deno.writeTextFile(
    `${dir}/notes.ts`,
    `import { cell } from "${REPO}mod.ts";
export const notes = cell("sv-notes", {
  state: { text: "hello" },
  selectors: { upper: (s: { text: string }) => s.text.toUpperCase() },
  methods: { setText(s, t: string) { s.text = t; } },
});
`,
  );
  const component = (name: string, body: string) =>
    Deno.writeTextFile(
      `${dir}/${name}.ts`,
      `import { h } from "${REPO}src/air/vdom.ts";
import { settings } from "./settings.ts";
import { notes } from "./notes.ts";
void settings; void notes;
export default function App() { return h("main", null, ${body}); }
`,
    );
  await component("Secret", `h("p", null, "key:" + settings.apiKey)`);
  await component("Theme", `h("p", null, "theme:" + settings.theme)`);
  await component("Selector", `h("p", null, "len:" + settings.keyLen())`);
  await component("Deep", `h("p", null, "k:" + settings.account.key)`);
  await component(
    "DeepName",
    `h("p", null, "name:" + settings.account.name)`,
  );
  await component("UiOnly", `h("p", null, "note:" + notes.upper())`);
  await component("UiOnlyCall", `h("p", null, String(notes.setText("x")))`);
  return dir;
}

const LIVE = {
  "sv-settings": {
    theme: "dark",
    apiKey: "lightkey:secret1235",
    account: { name: "ada", key: "deep-secret" },
  },
};

let dir: string;
let settings: Record<string, unknown>;

async function setup(): Promise<void> {
  if (dir) return;
  dir = await fixture();
  // The server's side of it: the cell bound to live state, exactly as boot
  // binds it. `notes` is left unbound — the UI imports it, the server entry
  // never did.
  const mod = await import(toFileUrl(`${dir}/settings.ts`).href);
  settings = mod.settings;
  // deno-lint-ignore no-explicit-any
  bindCell(mod.settings as any, () => Promise.resolve(), () => LIVE);
}

Deno.test("headless surface: a visible.exclude'd field refuses, as in the client", async () => {
  await setup();
  const r = await renderHeadlessSurface(`${dir}/Secret.ts`);
  assertFalse(r.ok, `rendered a hidden field: ${JSON.stringify(r)}`);
  assertStringIncludes(r.error, "sv-settings.apiKey read in client context");
  assertFalse(r.error.includes("secret1235"), r.error);
  // The server's own read is untouched — the client view lasts one render.
  assertEquals(settings.apiKey, "lightkey:secret1235");
});

Deno.test("headless surface: visible fields still read LIVE server state", async () => {
  await setup();
  const r = await renderHeadlessSurface(`${dir}/Theme.ts`);
  assert(r.ok, !r.ok ? r.error : "");
  assertStringIncludes(JSON.stringify(r.roots), "theme:dark");
});

Deno.test("headless surface: a selector over a hidden field refuses too", async () => {
  await setup();
  const r = await renderHeadlessSurface(`${dir}/Selector.ts`);
  assertFalse(r.ok, `selector saw a hidden field: ${JSON.stringify(r)}`);
  assertStringIncludes(r.error, "sv-settings.apiKey");
});

Deno.test("headless surface: a dot-path exclude refuses the nested read", async () => {
  await setup();
  const deep = await renderHeadlessSurface(`${dir}/Deep.ts`);
  assertFalse(
    deep.ok,
    `rendered a nested hidden field: ${JSON.stringify(deep)}`,
  );
  assertStringIncludes(deep.error, "sv-settings.account.key");
  assertFalse(deep.error.includes("deep-secret"), deep.error);
  const name = await renderHeadlessSurface(`${dir}/DeepName.ts`);
  assert(name.ok, !name.ok ? name.error : "");
  assertStringIncludes(JSON.stringify(name.roots), "name:ada");
});

Deno.test("headless surface: a cell only the UI imports renders its selectors", async () => {
  await setup();
  const r = await renderHeadlessSurface(`${dir}/UiOnly.ts`);
  assert(r.ok, !r.ok ? r.error : "");
  assertStringIncludes(JSON.stringify(r.roots), "note:HELLO");
});

Deno.test("headless surface: a method on a cell the server never bound says so", async () => {
  await setup();
  const r = await renderHeadlessSurface(`${dir}/UiOnlyCall.ts`);
  assertFalse(r.ok, JSON.stringify(r));
  assertStringIncludes(r.error, "[sv-notes] setText() called before");
  // …and the component it escaped from, as the browser's report names it.
  assertStringIncludes(r.error, "(in <App>)");
});

Deno.test("headless surface: a render that throws leaves no live root behind", async () => {
  await setup();
  const before = _liveRoots.size;
  const r = await renderHeadlessSurface(`${dir}/Secret.ts`);
  assertFalse(r.ok);
  assertEquals(_liveRoots.size, before);
  await dropTempDir(dir);
});

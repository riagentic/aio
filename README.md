<p align="center">
  <img src="docs/aio-logo.svg" alt="aio" width="380">
</p>

<p align="center">
  <b>Write the state. Get the app.</b><br>
  One <code>cell</code> is your server state, your database, your sync and your UI —
  building to browser, desktop and Android from the same two files.
</p>

<p align="center">
  <code>v1.0.0-beta1</code> · <a href="LICENSE">MIT</a> ·
  <a href="docs/content.md">Docs</a> ·
  <a href="docs/basics/quickstart.md">Quickstart</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## ⚡ Start

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
am create my-app && cd my-app && deno task dev
```

That is a running app — persisted, synced, testable — and one flag from the
rest:

- 🖥️ **Desktop** — `deno task dev --client=electron`
- 📱 **Android** — `deno task build --targets=android`
- 📦 **One binary** — `deno task compile`
- 🪟 **Windows** — install with `irm …/install.ps1 | iex`

Proven where: every release is gate-built and booted on Linux — server, browser,
Electron AppImage, and the one-line install on a fresh Ubuntu container — and
its Windows scripts run under Wine. A real Windows or macOS machine, an Android
device and iOS are not yet release gates; `deno task check:proof` prints what
has actually been measured.

## 🧠 The idea

State lives in a `cell`. You never write a store, an endpoint, a query, a
migration, or a fetch — the cell **is** all of them.

```ts
// counter.ts
import { cell } from "aio";

export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});
```

```tsx
// App.tsx — reads are reactive, calls dispatch. No hooks, no wiring.
import { counter } from "./counter.ts";

export default function App() {
  return (
    <button type="button" onClick={() => counter.increment()}>
      {counter.count}
    </button>
  );
}
```

Two files. `count` is persisted to SQLite, broadcast to every client as a delta,
restored on restart, and drivable from a test — because it is state, and state
is aio's whole job.

<p align="center">
  <img src="docs/img/theme.png" alt="the todo example in light and dark, styled entirely by aio's default theme" width="860">
</p>

<p align="center"><i>
  <a href="examples/todo">examples/todo</a> — 3 files, no stylesheet.
  Light and dark come from <a href="docs/ui/theme.md"><code>ui.theme</code></a>,
  whose accent is derived from the app's own name.
</i></p>

## 🧪 And its test, in full

Components are semantic APIs, so a test needs no selectors, no DOM scraping and
no setup — `<button>Add</button>` is `ui.AddButton`.

```ts
import { testUI } from "aio/testing";
import { todo } from "./todo.ts";
import App from "./App.tsx";

testUI(App, "add a todo", async (ui) => {
  ui.TitleInput.type("buy milk"); //  actions queue in order — no await
  ui.AddButton.click();
  await ui.expectCell(todo, (t) => t.items.length === 1); // observing awaits
});
```

`testUI` builds the DOM, boots every cell your `App` imports, and tears the lot
down. The same app is drivable while it runs: `am surface` prints what is on
screen, `am trigger` acts on it.

## 📦 What you get

|                |                                                                        |
| -------------- | ---------------------------------------------------------------------- |
| 💾 **Data**    | worker-thread SQLite · CRDT sync · offline queue · migrations · backup |
| 🎨 **UI**      | signals renderer · a default theme · routing · forms · SSR + hydrate   |
| 🔐 **Auth**    | sessions · per-user tokens · TOTP · OIDC · PIN pairing                 |
| 🧪 **Testing** | `testCell` / `testUI` — semantic, selector-free · time-travel          |
| 🚚 **Ship**    | browser · Electron · Android · CLI · systemd service · signed updates  |
| 🛠️ **Operate** | `am` — status, health, logs, state, dispatch, pins, installs           |

A whole client — renderer, protocol, offline queue, CRDT merge — is **67 KB
gzipped**, 59 KB brotli. `deno task bench:bundle` prints it, and
`tests/bundle-size.test.ts` keeps this sentence true — both numbers.

## 🏃 Run any aio app, from its repo

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh -s owner/repo
```

Installs what is missing, builds, starts it. Nothing to read first.

**[→ Every doc on one page](docs/content.md)** ·
[Concepts](docs/basics/concepts.md) · [Pitfalls](docs/basics/pitfalls.md) ·
[API](docs/basics/api-reference.md) · [`am`](docs/clients/app-manager.md)

## 🎯 Honestly

- 🧊 **Beta — the surface is frozen.** An app that compiles and runs against
  `v1.0.0-alpha76` compiles and runs against every later release, up to and
  including `1.0.0`. Additions only, enforced by `deno task check:api`, not by
  good intentions.
- ✅ **Built for** apps where state is the product — dashboards, ops and trading
  tools, control panels, internal tools, local-first desktop and mobile.
- ❌ **Not for** content sites, SEO, or planet-scale public APIs. It is one
  embedded process, by design.

[Positioning & non-goals](docs/basics/positioning.md)

## License

[MIT](LICENSE)

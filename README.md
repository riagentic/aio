<p align="center">
  <img src="docs/aio-logo.svg" alt="aio" width="380">
</p>

<p align="center">
  <b>Write the state. Get the app.</b><br>
  One <code>cell</code> is your server state, your database, your sync and your UI —
  building to browser, desktop and mobile from the same two files.
</p>

<p align="center">
  <code>v1.0.12-beta</code> · <a href="LICENSE">MIT</a> ·
  <a href="docs/content.md">Docs</a> ·
  <a href="docs/basics/quickstart.md">Quickstart</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## ⚡ Start

**1. Install `am`** (installs Deno too, if missing)

Shell (Mac, Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
```

PowerShell (Windows — needs [Git](https://git-scm.com/download/win) first:
`winget install Git.Git`):

```powershell
irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
```

**2. Create an app and run it** (any shell, PowerShell included)

```sh
am create my-app
cd my-app
deno task dev
```

> 🤖 **Working on this with an AI agent?** Have it run **`am agent`** first. One
> command prints the whole contract — the model, the verbs, and the habits that
> make an agent hostile to the machine it is running on — so it does not have to
> decide to open a doc. Every scaffolded app gets an `AGENTS.md` that says the
> same.

That is a running app — persisted, synced, testable — and one flag from the
rest:

- 🖥️ **Desktop** — `deno task dev --client=electron`
- 📱 **Mobile** — Android, `deno task build --targets=android` (a standalone
  APK); iPhone, `--targets=ios-client` (an Xcode project that connects to your
  server — Deno does not run on iOS)
- 📦 **One binary** — `deno task compile`

Proven where: every release is gate-built and booted on Linux — server, browser,
Electron AppImage, and the one-line install on a fresh Ubuntu container. The
Windows exe under Wine (`test:wine`) is an opt-in gate, not run for every
release. The desktop packages have been driven by hand on a real Windows 11 and
a real macOS 14 (Intel) machine in earlier betas; that, the packaged Windows
exe's security doors, an Android device and iOS have no automated gate.
`deno task check:proof` prints what has actually been run, when, and at which
commit — and marks a row stale when that commit is no longer in the repo.

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

|                |                                                                             |
| -------------- | --------------------------------------------------------------------------- |
| 💾 **Data**    | worker-thread SQLite · CRDT sync · offline queue · migrations · backup      |
| 🎨 **UI**      | signals renderer · a default theme · routing · forms · `renderToString` SSR |
| 🔐 **Auth**    | sessions · per-user tokens · TOTP · OIDC · PIN pairing                      |
| 🧪 **Testing** | `testCell` / `testUI` — semantic, selector-free · time-travel               |
| 🚚 **Ship**    | browser · Electron · Android · iOS client · CLI · service · signed updates  |
| 🛠️ **Operate** | `am` — status, health, logs, state, dispatch, pins, installs                |

A whole client — renderer, protocol, offline queue, CRDT merge — is **82 KB
gzipped**, 71 KB brotli. `deno task bench:bundle` prints it, and
`tests/bundle-size.test.ts` keeps this sentence true — both numbers.

## 🏃 Run any aio app, from its repo

Shell (Mac, Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh -s owner/repo
```

PowerShell (Windows):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1))) -Git owner/repo
```

Installs what is missing, builds, starts it. Nothing to read first.

**[→ Every doc on one page](docs/content.md)** ·
[Concepts](docs/basics/concepts.md) · [Pitfalls](docs/basics/pitfalls.md) ·
[API](docs/basics/api-reference.md) · [`am`](docs/clients/app-manager.md)

## 🏗️ Built with aio

The examples here are small on purpose; the apps built with aio so far are not.
More than 20 apps across many categories — desktop tools, local AI and NLP
front-ends, developer utilities, document viewers, web shops and trading
software — run on aio today: public ones like
[Claude Control](https://github.com/riagentic/cc), mdview, llama-master, spacy
and fixable, and private ones such as a trading platform, a 3D CAD editor and an
e-shop. Their bug reports shaped much of the framework.

## 🎯 Honestly

- 🧊 **Beta means the surface is frozen, not that the work is done.** An app
  that compiles and runs against `v1.0.0-alpha76` compiles and runs against
  every later release of the 1.x line — additions only, enforced by
  `deno task check:api`, not by good intentions. Versions run `1.0.0-beta`,
  `1.0.1-beta`, … and the first stable is the same triple without the suffix
  ([why](docs/basics/semver-policy.md)).
- 📏 **What is measured, and what is not.** Every release is gate-built and
  booted on Linux and in a fresh container. Wine is an opt-in gate, not run for
  every release. A real Windows or macOS machine (driven by hand in earlier
  betas), a physical Android device and iOS are **not** release gates yet —
  `deno task check:proof` prints exactly what has been run, and when. The suite
  is large; it is still one machine's opinion.
- 🧑‍🔬 **Real apps run on it** (listed above). Their field reports drove most of
  what changed since alpha52, and they still find bugs — the first beta was
  re-cut the same evening for one. Expect rough edges; please report them.
- ✅ **Built for** apps where state is the product — dashboards, ops tools,
  control panels, internal tools, local-first desktop and mobile.
- ❌ **Not for** anything that needs a CDN, a static export or horizontal
  scale-out — it is one embedded process, by design — or for native iOS (Deno
  does not run there; a thin WebView client does). A content site is fine: SSR,
  hydration and a per-page `<head>` are there; server components are not.

[Positioning & non-goals](docs/basics/positioning.md)

## License

[MIT](LICENSE)

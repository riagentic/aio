# Cookbook — twenty recipes, each one tested

Twenty things an app needs on its first day, each as a complete file you can
copy. The guides explain; [every option](every-option.md) is the lookup table;
this page is the paste buffer.

**Every snippet on this page is a checked artifact, not an illustration.**
`tests/cookbook-recipes.test.ts` reads this file, writes each fenced block to
disk as the file its first line names, and drives it — a cell through
`testCell`/`bootCells`, a component through `testUI`, a route through a real
`testServer`. `tests/docs-snippets-check.test.ts` type-checks every block on top
of that, against the same `aio` your editor resolves. A recipe that stopped
compiling, or stopped doing what it says, turns the suite red before you ever
read it.

Two recipes (18 and 20) carry an **illustrative last mile**: the code is driven
as far as an in-process test reaches, and the part that needs real hardware — an
OS camera device, a real worker thread — is named in the recipe rather than
faked. Nothing else on the page is an exception.

| #                                                         | Recipe                      | Driven by                            |
| --------------------------------------------------------- | --------------------------- | ------------------------------------ |
| [1](#1-a-list-that-persists-itself)                       | list: add, toggle, remove   | `testUI` + `testCell`                |
| [2](#2-view-state-the-server-never-sees)                  | client-scoped cell          | `testCell`                           |
| [3](#3-a-form-that-refuses-to-submit-until-it-is-valid)   | `useForm` validation        | `testUI`                             |
| [4](#4-show-the-change-before-the-server-confirms-it)     | `useOptimistic`             | `testUI`                             |
| [5](#5-one-method-calling-another)                        | `s.$call`                   | `testCell`                           |
| [6](#6-answer-an-identical-call-from-cache)               | `ttl`                       | `bootCells`                          |
| [7](#7-only-the-newest-search-wins)                       | `concurrency`               | `bootCells`                          |
| [8](#8-cancel-the-load-when-the-reader-leaves)            | `cancelOn`                  | `bootCells`                          |
| [9](#9-a-job-that-runs-every-five-minutes)                | `schedule.every`            | `bootCells` + `advance`              |
| [10](#10-migrate-when-the-state-shape-changes)            | `version` + `onMigrate`     | direct call                          |
| [11](#11-keep-a-secret-off-the-wire-and-out-of-reach)     | `visible` + `access`        | `testMultiClient` (real WS)          |
| [12](#12-show-each-user-only-their-own-rows)              | `visible.forUser`           | `testUI` with `user`                 |
| [13](#13-render-for-the-signed-in-user)                   | `useUser` / `SignIn`        | `testUI` with `user`                 |
| [14](#14-a-json-endpoint)                                 | `route()`                   | `testServer` (real HTTP)             |
| [15](#15-a-file-upload-that-keeps-only-metadata-in-state) | multipart route             | `testServer` (real HTTP)             |
| [16](#16-a-page-title-that-follows-the-route)             | `useRoute` + `useHead`      | `testUI`                             |
| [17](#17-a-keyboard-shortcut-that-belongs-to-no-element)  | `onGlobalKey`               | `testUI`                             |
| [18](#18-a-resource-you-must-close)                       | `useResource` + `onUnmount` | `testUI` (illustrative last mile)    |
| [19](#19-keep-one-broken-panel-from-taking-the-page)      | `ErrorBoundary`             | `testUI`                             |
| [20](#20-move-heavy-work-off-the-main-thread)             | `worker: true`              | `bootCells` (illustrative last mile) |

---

## 1. A list that persists itself

You want add / toggle / remove, surviving a restart, live in every open tab. All
three are the same thing in aio: methods on a cell. Nothing about persistence or
broadcast appears in your code — `persist` and `visible` default to `"all"`.

```ts
// src/cells/tasks.ts
import { cell } from "aio";

export type Task = { id: number; text: string; done: boolean };

export const tasks = cell("tasks", {
  state: { items: [] as Task[], nextId: 1 },
  methods: {
    add(s, text: string) {
      const t = text.trim();
      if (!t) throw new Error("a task needs text");
      s.items.push({ id: s.nextId++, text: t, done: false });
    },
    toggle(s, id: number) {
      const item = s.items.find((i) => i.id === id);
      if (item) item.done = !item.done;
    },
    remove(s, id: number) {
      s.items = s.items.filter((i) => i.id !== id);
    },
  },
  selectors: { remaining: (s) => s.items.filter((i) => !i.done).length },
});
```

The component reads the cell directly — `tasks.items` is a tracked read, so the
list re-renders when a method writes it. No store, no fetch, no `useEffect`.

```tsx
// src/TaskList.tsx
import type { JSX } from "aio";
import { useLocal } from "aio/air";
import { type Task, tasks } from "./cells/tasks.ts";

export default function TaskList(): JSX.Element {
  const { local: draft, set: setDraft } = useLocal("");
  return (
    <main>
      <form
        onSubmit={() => {
          if (!draft.trim()) return;
          tasks.add(draft);
          setDraft("");
        }}
      >
        <input
          aria-label="Task"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {tasks.items.map((t: Task) => (
          <li key={t.id}>
            <input
              type="checkbox"
              aria-label={`Done ${t.id}`}
              checked={t.done}
              onChange={() => tasks.toggle(t.id)}
            />
            <span>{t.text}</span>
            <button type="button" onClick={() => tasks.remove(t.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <p t="remaining">{tasks.remaining()} left</p>
    </main>
  );
}
```

`add` throws on empty text rather than returning quietly: a method that refuses
must say so, and `await tasks.add("")` then rejects at the call site. See
[pitfalls](pitfalls.md) on guard lines that silently no-op.

## 2. View state the server never sees

A filter, a sort order, a "which tab is open" — per tab, not per app. A
`scope: "client"` cell is a cell in every other way (methods, selectors,
reactive reads) that is never registered with the server, never synced and never
written to disk.

```ts
// src/cells/view.ts
import { cell } from "aio";

export type Filter = "all" | "active" | "done";

export const view = cell("view", {
  scope: "client",
  state: { filter: "all" as Filter, query: "" },
  methods: {
    setFilter(s, filter: Filter) {
      s.filter = filter;
    },
    setQuery(s, query: string) {
      s.query = query;
    },
  },
});
```

Use it when the state outlives a component (two components need the same
filter). For state that dies with one component instance, `useLocal` — recipe 1
— is smaller.

## 3. A form that refuses to submit until it is valid

`useForm` is called at module scope, like `signal`. `form.valid` is optimistic
until something runs the rules, so gate the SUBMIT on `form.validate()` rather
than disabling the button on first paint.

```tsx
// src/SignupForm.tsx
import type { JSX } from "aio";
import { useForm } from "aio/air";
import { signup } from "./cells/signup.ts";

const form = useForm({
  email: {
    initial: "",
    rules: [
      (v: string) => v.trim() ? null : "Email is required",
      (v: string) => v.includes("@") ? null : "That is not an email",
    ],
  },
  password: {
    initial: "",
    rules: [(v: string) => v.length >= 8 ? null : "At least 8 characters"],
  },
});

export default function SignupForm(): JSX.Element {
  return (
    <form
      onSubmit={() => {
        if (!form.validate()) return; // touches every field, shows every error
        signup.submit(form.values().email);
        form.reset();
      }}
    >
      <input
        aria-label="Email"
        {...form.bind("email")}
        value={form.fields.email.value}
      />
      <span t="emailError">{form.fields.email.error ?? ""}</span>

      <input
        type="password"
        aria-label="Password"
        {...form.bind("password")}
        value={form.fields.password.value}
      />
      <span t="passwordError">{form.fields.password.error ?? ""}</span>

      <button type="submit" t="submit">Sign up</button>
    </form>
  );
}
```

```ts
// src/cells/signup.ts
import { cell } from "aio";

export const signup = cell("signup", {
  state: { accepted: [] as string[] },
  methods: {
    submit(s, email: string) {
      if (!email.includes("@")) throw new Error("not an email");
      s.accepted.push(email);
    },
  },
});
```

The cell re-checks what the form checked. That is not duplication — the form
guards the keyboard, the method guards the wire, and only one of them is
reachable by `curl`. Full rule reference: [AIR forms](../ui/air-forms.md).

## 4. Show the change before the server confirms it

`useOptimistic` layers a pending action over the real value and drops it the
moment the real value changes. The method is still the only writer.

```tsx
// src/LikeButton.tsx
import type { JSX } from "aio";
import { useOptimistic } from "aio/air";
import { likes } from "./cells/likes.ts";

export default function LikeButton(): JSX.Element {
  const [shown, addOptimistic] = useOptimistic(
    likes.count,
    (current: number, delta: number) => current + delta,
  );
  return (
    <button
      type="button"
      t="like"
      onClick={() => {
        addOptimistic(1); // paints now
        likes.like(); // lands when the server acks
      }}
    >
      <span t="count">{shown}</span> likes
    </button>
  );
}
```

```ts
// src/cells/likes.ts
import { cell, sleep } from "aio";

export const likes = cell("likes", {
  state: { count: 0 },
  methods: {
    async like(s) {
      await sleep(30); // stands in for the slow part
      s.count++;
    },
  },
});
```

If the call fails the optimistic layer still clears — it is tied to the
passthrough value changing, not to success. Show the failure from
`cell:__error`, never by guessing in the component.

## 5. One method calling another

`myCell.other()` from inside a method is a SECOND dispatch: a second draft, a
second commit, and your uncommitted writes are invisible to it. `s.$call` runs
the sibling's body against **your** draft, in **your** commit.

```ts
// src/cells/bench.ts
import { cell, type MethodDraftCalls } from "aio";

type State = { status: string; samples: { kind: string; n: number }[] };

type Calls = { sample(kind: string): number };

export const bench = cell("bench", {
  state: { status: "idle", samples: [] } as State,
  methods: {
    sample(s: State, kind: string) {
      s.samples.push({ kind, n: s.samples.length });
      return s.samples.length;
    },
    run(s: State & Partial<MethodDraftCalls<Calls>>) {
      s.status = "running";
      s.$call!.sample("cold"); // sees status === "running"
      s.$call!.sample("warm"); // same draft, same commit
      s.status = "done";
    },
  },
});
```

`Partial<>` and the `!` are both required — the draft type a method receives
does not declare `$call`, and a method that REQUIRES a member the draft type
lacks is not a `Method<State>`. The refusals (an async sibling from a sync
method, a name the cell does not have, a cycle) are spelled out in
[methods](../state/methods.md).

## 6. Answer an identical call from cache

`ttl` is one line: for N milliseconds after a SUCCESSFUL async call, an
identical call (same method, same arguments) resolves from the previous result
without running the body.

```ts
// src/cells/weather.ts
import { cell } from "aio";
import { fetchWeather } from "./weather-api.ts";

export const weather = cell("weather", {
  state: { byCity: {} as Record<string, number>, loads: 0 },
  ttl: { load: 30_000 }, // an identical load("oslo") inside 30s does not re-run
  methods: {
    async load(s, city: string) {
      const degrees = await fetchWeather(city);
      s.byCity[city] = degrees;
      s.loads++;
    },
  },
});
```

`./weather-api.ts` is your own wrapper — one exported
`fetchWeather(city: string): Promise<number>`. Keeping the I/O in its own module
is what lets a test swap it; the cell stays the thing under test.

A failed call is not cached, so the next call retries. The clock is the same one
`ui.advance(ms)` / `handle.advance(ms)` move, so expiry is testable without
waiting 30 seconds.

## 7. Only the newest search wins

Every keystroke starts a call; you want the last one's answer, not the last
one's to ARRIVE. `concurrency: "newest"` aborts the in-flight call when a new
one starts.

```ts
// src/cells/search.ts
import { cell, sleep } from "aio";

export const search = cell("search", {
  state: { query: "", hits: [] as string[] },
  concurrency: { run: "newest" }, // "first" drops the new one; "queue" serialises
  methods: {
    async run(s, query: string) {
      s.query = query;
      await sleep(50); // your index lookup
      s.hits = [`${query}-1`, `${query}-2`];
    },
  },
});
```

The three modes and what each does to the loser are in
[methods](../state/methods.md). For a search box, also debounce the keystrokes —
recipe 9's `schedule.after` is the debounce primitive.

## 8. Cancel the load when the reader leaves

`cancelOn` names, per async method, the actions that abort it. `self("close")`
is another method of the same cell; a foreign cell's action creator
(`nav.leave`) works the same way.

```ts
// src/cells/article.ts
import { cell, type MethodDraftMeta, self, sleep } from "aio";

type ArticleState = { body: string; loading: boolean };

export const article = cell("article", {
  state: { body: "", loading: false } as ArticleState,
  cancelOn: { open: [self("close")] },
  methods: {
    async open(s: ArticleState & MethodDraftMeta, id: string) {
      s.loading = true;
      await sleep(1000); // your fetch — hand `s.$signal` to anything abortable
      s.loading = false; // clear your own flag whether or not you were cancelled
      if (s.$signal.aborted) return; // cancelled: drop the stale write
      s.body = `article ${id}`;
    },
    close(s: ArticleState) {
      s.body = "";
      s.loading = false;
    },
  },
});
```

Cancelling ABORTS `s.$signal`; it does not stop the function. So pass the signal
to every abortable call and check `s.$signal.aborted` after each `await` before
writing terminal state — that check is what stops a superseded run overwriting a
fresh one. `cancelOn: { open: "self" }` is the shorthand for "a newer `open`
cancels the older one", and `concurrency: { open: "newest" }` (recipe 7) is the
same instruction under another name.

## 9. A job that runs every five minutes

Effects go through `s.$do`, never a `return` and never `setInterval`.
`schedule.every(id, ms, action)` repeats until something cancels the id;
`schedule.after(id, ms, action)` is the one-shot (and the debounce).

```ts
// src/cells/digest.ts
import { cell, schedule, self } from "aio";

export const digest = cell("digest", {
  state: { ticks: 0, running: false },
  methods: {
    start(s) {
      s.running = true;
      s.$do(schedule.every("digest", 300_000, self("tick")));
    },
    tick(s) {
      s.ticks++; // read the clock and the state HERE — the action is frozen
    },
    stop(s) {
      s.running = false;
      s.$do(schedule.cancel("digest")); // the id is the handle
    },
  },
});
```

Every tick re-sends the same action object, payload included, so read anything
that changes inside the method rather than passing it in. Durations are plain
numbers of milliseconds — `every: "5m"` is refused at boot, by name. For jobs
owned by the app rather than by a cell, `aio.run({ schedules: [...] })` takes
the same shape; see [scheduling](../state/scheduling.md).

## 10. Migrate when the state shape changes

Persisted state deep-merges with your defaults, so ADDING a field needs nothing.
A rename or a type change needs `version` + `onMigrate` — and bumping `version`
without an `onMigrate` boots with a loud warning rather than quietly keeping the
old shape.

```ts
// src/cells/prefs.ts
import { cell } from "aio";

export type Prefs = { theme: "light" | "dark"; tags: string[] };

/** v1 stored `dark: boolean`; v2 stores `theme` and adds `tags`. Exported so a
 *  test can call it with real v1 data — a migration you cannot run is a guess. */
export function migratePrefs(state: Prefs, from: number): Prefs {
  const old = state as Prefs & { dark?: boolean };
  if (from < 2) {
    return { theme: old.dark ? "dark" : "light", tags: old.tags ?? [] };
  }
  return state;
}

export const prefs = cell("prefs", {
  version: 2,
  onMigrate: migratePrefs,
  state: { theme: "light", tags: [] } as Prefs,
  methods: {
    setTheme(s, theme: "light" | "dark") {
      s.theme = theme;
    },
  },
});
```

Renaming the CELL (`cell("prefs", …)` → `cell("settings", …)`) is not a
migration — the string is the persistence key, and a rename orphans the data.
Bump `version` instead.

## 11. Keep a secret off the wire, and out of reach

`visible` gates READS. `access` gates CALLS. Neither implies the other: a cell
with `visible: "none"` still has every method callable by any connected client,
with the return value travelling straight back. Say both.

```ts
// src/cells/vault.ts
import { cell } from "aio";

export const vault = cell("vault", {
  state: { label: "prod", apiKey: "sk-live-xxxx" },
  visible: { exclude: ["apiKey"] }, // the broadcast carries `label` only
  access: false, // and no client may call in at all
  methods: {
    reveal: (s) => s.apiKey, // server-side callers only
    rotate(s, next: string) {
      s.apiKey = next;
    },
  },
});
```

`exclude` takes dot-paths that reach into arrays and into records-by-id
(`"accounts.secret"` covers both). `include` is top-level only. `access` also
takes a role string or a predicate `(user, name, ...args) => boolean` when
"nobody" is too blunt. Full matrix:
[cell visibility](../state/cell-visibility.md).

## 12. Show each user only their own rows

`visible.forUser` runs once per client per broadcast and returns that client's
view. The server keeps the whole table; each socket receives its slice.

```ts
// src/cells/notes.ts
import { cell } from "aio";

export type Note = { id: number; owner: string; text: string };

export const notes = cell("notes", {
  state: {
    rows: [
      { id: 1, owner: "sita", text: "mine" },
      { id: 2, owner: "bo", text: "theirs" },
    ] as Note[],
  },
  visible: {
    // inline, not a named helper — a named one breaks contextual typing
    forUser: (s, user) => ({
      rows: s.rows.filter((r: Note) => r.owner === user?.id),
    }),
  },
  methods: {
    add(s, owner: string, text: string) {
      s.rows.push({ id: s.rows.length + 1, owner, text });
    },
  },
});
```

```tsx
// src/NoteList.tsx
import type { JSX } from "aio";
import { type Note, notes } from "./cells/notes.ts";

export default function NoteList(): JSX.Element {
  return (
    <ul t="notes">
      {notes.rows.map((n: Note) => <li key={n.id}>{n.text}</li>)}
    </ul>
  );
}
```

`forUser` and `sync` cannot both hold — CRDT ops carry no user dimension. A cell
with `forUser` is broadcast as full state per client rather than as a patch,
which is the cost of the guarantee.

## 13. Render for the signed-in user

`useUser()` answers `undefined` while the identity is still being resolved,
`null` for anonymous, and the user otherwise. Render all three: the `undefined`
branch is what stops a signed-in app flashing its login screen on every reload.

```tsx
// src/Account.tsx
import type { JSX } from "aio";
import { SignIn, signOut, useUser } from "aio/air";

export default function Account(): JSX.Element {
  const user = useUser();
  if (user === undefined) return <p t="status">Checking</p>;
  if (user === null) return <SignIn />;
  return (
    <div>
      <p t="status">Signed in as {user.id} ({user.role})</p>
      <button type="button" onClick={() => signOut()}>Sign out</button>
    </div>
  );
}
```

The server side is one key — `auth: true` for full login flows, `users` /
`resolveUser` for per-user tokens, `key: true` for a single shared key. What the
`<SignIn/>` form offers adapts to what the server enabled. See
[auth](../auth/auth.md).

## 14. A JSON endpoint

State flows over the state channel; everything else — webhooks, an API for
somebody else's script — flows through `routes`. `route()` adds `:id` params, a
method guard, cookies and a JSON helper on top of a raw `(req) => Response`
handler.

```ts
// src/routes/api.ts
import { type RawRouteHandler, route } from "aio";
import { tasks } from "../cells/tasks.ts";

export const apiRoutes: Record<string, RawRouteHandler> = {
  "/api/tasks": route((ctx) => ctx.json({ items: tasks.items }), {
    method: "GET",
  }),

  "/api/tasks/:id/done": route((ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id)) {
      return ctx.json({ error: "bad id" }, { status: 400 });
    }
    tasks.toggle(id);
    return ctx.json({ ok: true });
  }, { method: "POST" }),
};
```

Wire it with `aio.run({ cells: [tasks], routes: apiRoutes })`. A `:param` is
URL-decoded, so it can contain `/` and `..` — treat it as untrusted input, which
is why the handler above checks the id before using it.

## 15. A file upload that keeps only metadata in state

Bytes do not belong in cell state — they would be persisted, diffed and
broadcast. Take the upload through a route, write the bytes somewhere, and put
only the metadata in the cell, where it syncs to every client for free.

```ts
// src/routes/upload.ts
import { type RawRouteHandler, route } from "aio";
import { files } from "../cells/files.ts";

const MAX = 10_000_000;

/** `dir` is the app's own storage directory — `app.dirs.data` from `aio.run()`,
 *  or any path you control. */
export function uploadRoutes(dir: string): Record<string, RawRouteHandler> {
  return {
    "/upload": route(async (ctx) => {
      const file = (await ctx.req.formData()).get("file");
      if (!(file instanceof File) || file.size === 0 || file.size > MAX) {
        return ctx.json({ error: "file required (≤10MB)" }, { status: 400 });
      }
      const id = crypto.randomUUID();
      await Deno.writeFile(
        `${dir}/${id}`,
        new Uint8Array(await file.arrayBuffer()),
      );
      files.record(id, file.name, file.size);
      return ctx.json({ id });
    }, { method: "POST" }),

    "/uploads/:id": route(async (ctx) => {
      const id = ctx.params.id ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) {
        return ctx.json({ error: "bad id" }, { status: 400 });
      }
      try {
        return new Response(await Deno.readFile(`${dir}/${id}`));
      } catch {
        return ctx.json({ error: "not found" }, { status: 404 });
      }
    }, { method: "GET" }),
  };
}
```

```ts
// src/cells/files.ts
import { cell } from "aio";

export type FileMeta = { id: string; name: string; size: number };

export const files = cell("files", {
  state: { items: [] as FileMeta[] },
  methods: {
    record(s, id: string, name: string, size: number) {
      s.items.push({ id, name, size });
    },
  },
});
```

The browser side is plain `fetch("/upload", { method: "POST", body: form })` —
the metadata reaches every open tab through the state channel, not through the
response.

## 16. A page title that follows the route

`useHead` owns its part of `<head>` for as long as the component is mounted and
gives it back on unmount, so two pages cannot fight over the title.

```tsx
// src/PostPage.tsx
import type { JSX } from "aio";
import { useHead, useRoute } from "aio/air";
import { posts } from "./cells/posts.ts";

export default function PostPage(): JSX.Element {
  const { params, matched } = useRoute<{ id: string }>("/posts/:id");
  const post = matched ? posts.byId[params.id ?? ""] : undefined;

  useHead({
    title: post ? `${post.title} — Notes` : "Notes",
    meta: [{ name: "description", content: post?.summary ?? "All posts" }],
  });

  return <article t="post">{post?.title ?? "Pick a post"}</article>;
}
```

```ts
// src/cells/posts.ts
import { cell } from "aio";

export type Post = { title: string; summary: string };

export const posts = cell("posts", {
  state: {
    byId: {
      "1": { title: "Hello", summary: "The first one" },
    } as Record<string, Post>,
  },
  methods: {
    add(s, id: string, post: Post) {
      s.byId[id] = post;
    },
  },
});
```

`useRoute` reads the router's signals, so the title re-derives on navigation
with no subscription of your own. Routing itself:
[AIR routing](../ui/air-routing.md).

## 17. A keyboard shortcut that belongs to no element

`onGlobalKey` binds at the document for exactly as long as the component is
mounted — no `addEventListener` in `onMount`, no cleanup to forget. It ignores
the chord while focus is in a text field, which is what you want and what a
hand-rolled listener always gets wrong.

```tsx
// src/Palette.tsx
import type { JSX } from "aio";
import { onGlobalKey } from "aio/air";
import { palette } from "./cells/palette.ts";

export default function Palette(): JSX.Element {
  onGlobalKey("k", () => palette.open(), { mod: true }); // ⌘K / Ctrl-K
  onGlobalKey("Escape", () => palette.close());
  return (
    <div>
      <span t="paletteState">{palette.open_ ? "open" : "closed"}</span>
      <input aria-label="Command" />
    </div>
  );
}
```

```ts
// src/cells/palette.ts
import { cell } from "aio";

export const palette = cell("palette", {
  scope: "client",
  state: { open_: false },
  methods: {
    open(s) {
      s.open_ = true;
    },
    close(s) {
      s.open_ = false;
    },
  },
});
```

From a test, `ui.<anything>.press("Escape")` bubbles to the document — but aim
it at something that is NOT an input, or the ignore-in-field rule swallows it
and the test passes while asserting nothing.

## 18. A resource you must close

A camera, a socket, a file handle — something with an open, a close, and a bill
for getting it wrong. `useResource` gives one handle per component instance,
re-opens when the key changes, and closes when the last holder unmounts. Do not
wire it to `onCleanup` in the body: that fires before every re-render, which
opens and closes the device on every paint.

```tsx
// src/CameraView.tsx
import type { JSX } from "aio";
import { useResource } from "aio/air";
import { closeCamera, openCamera } from "./media.ts";
import { view } from "./cells/view.ts";

export default function CameraView(): JSX.Element {
  const cam = useResource({
    key: () => view.query || "default", // re-opens when the id changes
    open: (id, { signal }) => openCamera(String(id), signal),
    close: (stream) => closeCamera(stream),
  });

  if (cam.error.value) return <p t="cam">failed</p>;
  return <p t="cam">{cam.value ? "live" : "opening"}</p>;
}
```

`./media.ts` is your own wrapper: `openCamera(id, signal)` returning the handle
and `closeCamera(handle)` releasing it. The `signal` aborts when the key changes
again or the holder disposes, so a slow open can stand down instead of landing
late and leaking.

**Illustrative last mile.** The test drives the mount/re-key/unmount sequence
and asserts every open is matched by a close, against a stand-in `media.ts`. It
cannot prove `getUserMedia` releases a real device — no test in this repo can.
When you hold a real one, check it with `onUnmount` logging and your OS's camera
indicator.

## 19. Keep one broken panel from taking the page

A render that throws with no boundary above it takes the whole tree.
`ErrorBoundary` catches render errors — initial render, signal-driven re-render,
and a lazy component's rejection — and swaps in a fallback. Event-handler errors
are NOT caught (same rule as React); a failing method surfaces through
`cell:__error`.

```tsx
// src/Dashboard.tsx
import type { JSX } from "aio";
import { ErrorBoundary, h } from "aio/air";
import { RiskyPanel } from "./RiskyPanel.tsx";

export default function Dashboard(): JSX.Element {
  return (
    <main>
      <h1>Dashboard</h1>
      {h(
        ErrorBoundary,
        { fallback: (e: Error) => h("p", null, `Panel failed: ${e.message}`) },
        h(RiskyPanel, null),
      )}
      <footer>still here</footer>
    </main>
  );
}
```

`ErrorBoundary` is a symbol sentinel rather than a component, so it is written
with `h(...)`. Recovery is automatic: the failing component stays subscribed,
and the next signal change re-renders it for real.

## 20. Move heavy work off the main thread

A parse, a crunch, an FFI call that blocks. `worker: true` runs that cell's
methods in their own Deno isolate on their own OS thread, so the work can only
stall THAT cell — the rest of the app keeps dispatching and broadcasting.

```ts
// src/cells/thumbs.ts
import { cell } from "aio";

export const thumbs = cell("thumbs", {
  worker: true, // this cell's methods run off the main thread
  state: { done: 0, lastHash: 0 },
  methods: {
    hash(s, input: string) {
      let h = 0;
      for (let i = 0; i < input.length; i++) {
        h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
      }
      s.lastHash = h;
      s.done++;
      return h;
    },
  },
});
```

Arguments and return values cross a structured-clone boundary, so they must be
serialisable and the cell cannot reach another cell's live state — talk to other
cells by calling their methods. Nothing else changes: it is still
`thumbs.hash(…)` from the UI.

**Illustrative last mile.** Tests boot worker cells in-isolate by default, which
reproduces the serialization boundary but not the thread. Real workers are
`testServer({ workers: "real", workerEntry })` — an entry that defines the same
cells and calls `aio.run({ libraryMode: true })` under `isCellWorker()`. See
[cell workers](../state/cell-workers.md).

---

## Where to go next

- [Every option, one page](every-option.md) — the signature of every key used
  above.
- [Common pitfalls](pitfalls.md) — the traps these recipes route around.
- [UI testing](../testing/ui-testing.md) and
  [cell testing](../testing/cell-testing.md) — how the proofs above are written.
- [Integrations](../examples/05-integrations.md) — routes, uploads and external
  APIs at length.

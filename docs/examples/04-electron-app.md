# Building a Desktop Note-Taking App with Electron

A local-first note-taking app: SQLite persistence, URL routing, single-instance
lock, compiled to AppImage. The stack is aio + Electron + SQLite + AIR. No
cloud, no accounts — just your notes on your machine.

## Step 1: Project setup

```json
{
  "version": "0.1.0",
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "compile:electron": "deno run -A src/app.ts --compile"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@^1.0.0-alpha17"
  }
}
```

> **Install:** use the scaffolder or the vendored path (see
> [Quickstart](../basics/quickstart.md)) — a scaffolded `deno.json` maps `aio`
> to `./dep/aio/mod.ts`. The `jsr:` pins above apply once
> [@riagentic/aio](https://jsr.io/@riagentic/aio) is published.

File structure:

```
src/
  app.ts           # entry — wires cells, boots aio
  notes.ts         # notes cell — state, methods, SQLite schema
  ui.tsx           # AIR UI — sidebar, editor, settings
```

Three files. That's the whole app.

## Step 2: Notes cell

Methods mutate state directly — aio tracks changes and syncs to the UI.

```ts
// src/notes.ts
import { cell } from "aio";

type Note = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
};

type NotesState = {
  notes: Note[];
  active: string | null;
  search: string;
};

export const notes = cell("notes", {
  state: {
    notes: [],
    active: null as string | null,
    search: "",
  } satisfies NotesState,

  methods: {
    create(s: NotesState, title: string) {
      const id = crypto.randomUUID();
      s.notes.unshift({ id, title, content: "", createdAt: Date.now() });
      s.active = id;
    },

    update(s: NotesState, id: string, content: string) {
      const note = s.notes.find((n) => n.id === id);
      if (note) note.content = content;
    },

    rename(s: NotesState, id: string, title: string) {
      const note = s.notes.find((n) => n.id === id);
      if (note) note.title = title;
    },

    delete(s: NotesState, id: string) {
      s.notes = s.notes.filter((n) => n.id !== id);
      if (s.active === id) s.active = s.notes[0]?.id ?? null;
    },

    select(s: NotesState, id: string) {
      s.active = id;
    },

    search(s: NotesState, query: string) {
      s.search = query;
    },
  },

  selectors: {
    filtered: (s: NotesState) => {
      if (!s.search) return s.notes;
      const q = s.search.toLowerCase();
      return s.notes.filter((n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q)
      );
    },
  },
});
```

> Methods receive an Immer draft — mutate freely, aio produces immutable
> snapshots under the hood. `search` sets a filter string; the `filtered`
> selector does the actual filtering.

## Step 3: SQLite persistence

```ts
// src/app.ts
import { aio } from "aio";
import { integer, pk, table, text } from "aio";
import { notes } from "./notes.ts";

const app = await aio.run({
  appId: "aio-notes",
  cells: [notes],

  db: {
    notes: table({
      id: text({ unique: true }),
      title: text(),
      content: text({ default: "" }),
      createdAt: integer(),
    }),
  },

  singleton: true,

  ui: {
    title: "Notes",
    width: 1000,
    height: 700,
  },
});
```

When `db` has a table named `notes` and your cell state has a `notes` array, aio
auto-syncs. Rows load on startup; inserts/updates/deletes propagate to SQLite on
state change.

### Cell-level UI config: don't send everything

Sending all note content to the UI on every keystroke is wasteful. Configure
`ui` on the cell to send only what the renderer needs:

```ts
export const notes = cell("notes", {
  state: { notes: [], active: null, search: "" } satisfies NotesState,
  ui: {
    forUser: (exposed) => {
      const activeNote = exposed.notes.find((n: Note) =>
        n.id === exposed.active
      );
      return {
        notes: exposed.notes.map((n: Note) => ({
          id: n.id,
          title: n.title,
          createdAt: n.createdAt,
        })),
        active: exposed.active,
        activeNote, // full content for the selected note only
        search: exposed.search,
      };
    },
  },
  // ... methods, selectors
});
```

The UI gets a lightweight list plus the full active note. Edit a 50KB note? Only
that note's content crosses the wire.

## Step 4: URL routing

```tsx
function App() {
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar />
      <main style={{ flex: 1, padding: "1rem" }}>
        <Route path="/" index element={<NoteList />} />
        <Route path="/note/:id" element={<Editor />} />
        <Route path="/settings" element={<Settings />} />
      </main>
    </div>
  );
}
```

`Route` matches the current path. `/note/:id` extracts the note ID as a param.

```tsx
function Sidebar() {
  return (
    <nav style={{ width: 250, borderRight: "1px solid #ddd", padding: "1rem" }}>
      <button
        onClick={() =>
          notes.create("Untitled")}
      >
        New Note
      </button>
      <input
        placeholder="Search..."
        value={notes.search}
        onChange={(e) => notes.search(e.target.value)}
      />
      {notes.notes.map((n) => (
        <Link key={n.id} to={`/note/${n.id}`} activeClass="active">
          {n.title}
        </Link>
      ))}
      <Link to="/settings">Settings</Link>
    </nav>
  );
}
```

`Link` adds the `active` CSS class when the path matches. The editor uses
`useRoute` to pull the note ID from the URL:

```tsx
function Editor() {
  const { params } = useRoute("/note/:id");
  const navigate = useNavigate();
  if (!notes.activeNote) return <p>Select a note</p>;

  if (params.id !== notes.active) notes.select(params.id);

  return (
    <div>
      <input
        value={notes.activeNote.title}
        onChange={(e) => notes.rename(params.id, e.target.value)}
      />
      <textarea
        value={state.activeNote.content}
        onChange={(e) => send.update(params.id, e.target.value)}
        style={{ width: "100%", height: "calc(100vh - 120px)" }}
      />
      <button
        onClick={() => {
          send.delete(params.id);
          navigate("/");
        }}
      >
        Delete
      </button>
    </div>
  );
}

function Settings() {
  return <div>App settings go here.</div>;
}
```

## Step 5: Mount the UI

AIR mounts the default export automatically — no manual `mount()` call needed.
Direct cell access gives scoped state and typed methods — re-renders only when
notes state changes.

## Step 6: Single instance lock

We set `singleton: true` in the config. When the user double-clicks the app
while it's already running, the second process detects the lock file
(`/tmp/aio/aio-notes.lock`), sees the first process is alive, and exits. Stale
locks from crashed processes are cleaned up automatically.

Alternatives: `singleton: true, killExisting: true` kills the old instance and
starts fresh. `singleton: false` allows multiple instances (useful during
development).

## Step 7: Build to AppImage

```bash
deno run -A dep/aio/src/build.ts --compile --electron
```

This produces a self-contained binary. The Electron shell loads your UI from
disk via a custom `aio://` protocol (no HTTP server in prod). SQLite data lives
in `~/.local/share/aio-notes/`.

Window position persists automatically — built into aio's Electron launcher, no
code needed. App title and dimensions come from the `ui` config. To set a custom
icon, drop `icon.png` in `src/`.

## Step 8: Testing

Test note operations without booting the full app:

```ts
// src/notes.test.ts
import { assertEquals } from "@std/assert";
import { testCell } from "aio";
import { notes } from "./notes.ts";

testCell(notes, "create and select note", (t) => {
  t.send.create("First note");
  const s = t.getState();
  assertEquals(s.notes.length, 1);
  assertEquals(s.active, s.notes[0].id);
});

testCell(notes, "delete selects next", (t) => {
  t.send.create("A");
  t.send.create("B");
  const idB = t.getState().notes[0].id;
  t.send.delete(idB);
  const s = t.getState();
  assertEquals(s.active, s.notes[0].id);
});

testCell(notes, "search narrows the filtered selector", (t) => {
  t.send.create("Grocery list");
  t.send.create("Meeting notes");
  t.send.search("grocery");
  t.expect.state((s) => s.search === "grocery");
});
```

Run with `deno test src/`. `testCell` runs methods synchronously with full Immer
drafts — same behavior as production, zero setup.

---

That's the whole app: SQLite persistence, URL routing, single-instance lock,
optimized UI sync, and a compiled binary. aio handled Electron lifecycle, window
state, SQLite sync, state broadcasting, routing, and compilation. You wrote the
cell logic and the UI.

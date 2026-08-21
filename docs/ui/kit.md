# `aio/ui` — the component kit

A small, deliberately basic set of components for aio's core use case —
dashboards, ops tools, control panels. Not a design system: just the primitives
you'd otherwise rewrite in every app. They're native AIR components, so they
bind to cells with no adapter, and they're themed entirely through CSS custom
properties.

```tsx
import { Button, Card, Field, Input, Table, UiStyles } from "aio/ui";
```

## Setup — drop `<UiStyles/>` once

The kit's stylesheet renders through AIR (SSR- and test-safe). Place it once,
near your app root:

```tsx
import { UiStyles } from "aio/ui";

export default function App() {
  return (
    <div>
      <UiStyles />
      {/* your app */}
    </div>
  );
}
```

Everything keys off `--aio-ui-*` tokens with a light + dark default (follows
`prefers-color-scheme`), and **each one defaults to the matching token of the
[default theme](theme.md)** — so an app that opted into `ui.theme` gets kit
components in its own accent without doing anything.

Reskin at whichever level you mean:

```css
:root {
  /* theme-wide: the kit follows, and so does everything else */
  --aio-accent: #7c3aed;
  --aio-r-2: 12px;

  /* kit-only: overrides the component kit and nothing else */
  --aio-ui-radius: 12px;
  --aio-ui-line: #d8dee9;
}
```

| kit token            | defaults to       | what it colours             |
| -------------------- | ----------------- | --------------------------- |
| `--aio-ui-accent`    | `--aio-accent`    | primary fill, focus ring    |
| `--aio-ui-on-accent` | `--aio-on-accent` | the ink ON that fill        |
| `--aio-ui-ink`       | `--aio-text`      | body text in components     |
| `--aio-ui-ink-soft`  | `--aio-muted`     | secondary text              |
| `--aio-ui-bg`        | `--aio-surface`   | input/field background      |
| `--aio-ui-surface`   | `--aio-surface-2` | secondary button background |
| `--aio-ui-line`      | `--aio-border`    | borders and hairlines       |
| `--aio-ui-danger`    | `--aio-danger`    | destructive actions         |
| `--aio-ui-radius`    | `--aio-r-2`       | corner radius               |
| `--aio-ui-font`      | `--aio-font`      | component typeface          |

> Before alpha64 the kit defined bare `--aio-*` names of its own, two of which
> collided with the theme's under the same spelling — `--aio-accent-ink` meant
> "ink on the accent" here and "the accent as text" there. Nothing you wrote
> breaks: `--aio-accent` keeps working unchanged, and the four kit-only names
> (`--aio-radius`, `--aio-ink`, `--aio-ink-soft`, `--aio-line`) are still read —
> an explicit override of one of them wins over the theme's token, which wins
> over the kit's literal. Prefer the `--aio-ui-*` spellings in new code.

## Components

Every component accepts `class`, `style`, and any extra DOM attribute (`id`,
`aria-*`, `data-*`) as an escape hatch — they never fight your markup.

### Button

```tsx
<Button variant="primary" onClick={() => users.add()}>Add user</Button>
<Button variant="danger" size="sm" onClick={() => row.delete()}>Delete</Button>
```

`variant`: `primary · secondary · ghost · danger`. `size`: `sm · md · lg`.

### Inputs — `Input`, `Textarea`, `Select`, `Checkbox`

Handlers receive the **value**, not the event — so they wire straight to a cell
method:

```tsx
<Input value={form.email} onInput={(v) => form.setEmail(v)} invalid={!!errors.email} />
<Textarea value={form.bio} onInput={form.setBio} rows={4} />
<Select value={form.role} options={["admin", { value: "viewer", label: "Viewer" }]} onChange={form.setRole} />
<Checkbox checked={settings.notify} label="Email me" onChange={settings.setNotify} />
```

### Field — label + control + error

Wraps any control with a label, optional hint, and error message:

```tsx
<Field label="Email" required error={errors.email} hint="We never share it">
  <Input value={form.email} onInput={form.setEmail} invalid={!!errors.email} />
</Field>;
```

A string `label` also becomes the **accessible name** of the control inside
(unless it already has one, or a `t` handle) — so screen readers announce it and
[`testUI`](../testing/ui-testing.md) addresses it by name: `ui.EmailInput`,
never a positional `ui.find("Field", 1).Input`. The same holds for
`<Checkbox label="…">`, whose wrapping `<label>` names its box
(`ui.EmailMeCheckbox`).

### Table

A basic data table. Columns declare a `key`, an optional `header`, and an
optional `render`:

```tsx
const columns = [
  { key: "name", header: "Name" },
  { key: "role", header: "Role" },
  {
    key: "actions",
    header: "",
    render: (u) => (
      <Button size="sm" onClick={() => users.remove(u.id)}>×</Button>
    ),
  },
];

<Table
  columns={columns}
  rows={users.list}
  getKey={(u) => u.id}
  empty="No users yet"
  onRowClick={(u) => open(u)}
/>;
```

For very large datasets, drive `rows` with [`useVirtualList`](air-advanced.md)
and pass the visible window — the table itself stays deliberately simple.

### Modal

A dialog with backdrop, Escape-to-close, backdrop-click-to-close, and ARIA — the
primitive apps otherwise re-roll per form. The Escape listener attaches to AIR's
render document, so it works under `testUI`/SSR too.

```tsx
<Modal
  open={ui.confirmOpen}
  onClose={() => ui.closeConfirm()}
  title="Delete?"
  footer={<Button variant="danger" onClick={() => row.delete()}>Delete</Button>}
>
  This can't be undone.
</Modal>;
```

Pass `dismissable={false}` to require an explicit action (no Escape/backdrop
close). `role="dialog"`/`aria-modal` sit on the dialog box itself; the backdrop
is addressable as `ui.modalBackdrop` so a test can drive click-outside-to-close.

### Card + layout — `Card`, `Stack`, `Row`, `Spinner`

```tsx
<Card title="Revenue" footer="updated just now">
  <Stack gap={8}>
    <Row gap={12} align="center">
      <b>$12,480</b>
      <Spinner />
    </Row>
  </Stack>
</Card>;
```

### Avatar

Initials + a deterministic color from the name (same name → same color), or an
image via `src`.

```tsx
<Avatar name="Ada Lovelace" size={40} /> // "AL" on a stable color
<Avatar name={u.name} src={u.photo} />    // photo when available
```

### Pagination

Windowed pager — you own the data slice; it only reports the page the user
wants.

```tsx
<Pagination page={p} pages={Math.ceil(total / perPage)} onPage={setP} />;
```

Every button carries an `aria-label` ("Previous page", "Next page", "Page 3"),
so it is announced by a screen reader and drivable by name in tests
(`ui.NextPageButton.click()`).

### Confirm + `ConfirmButton`

The "are you sure?" for destructive actions — built on `Modal`, so focus /
Escape / ARIA come for free. `ConfirmButton` bundles the whole pattern into one
element (its `onConfirm` fires only after the user agrees):

```tsx
<ConfirmButton
  variant="danger" // makes the confirm button destructive too
  confirm="Delete this listing? This can't be undone."
  onConfirm={() => listings.remove(id)}
>
  Delete
</ConfirmButton>;

// or drive a Confirm yourself with your own open state:
<Confirm
  open={open}
  message="Discard changes?"
  onConfirm={discard}
  onCancel={close}
/>;
```

### Toast — `toast()` + `<ToastHost/>`

Render `<ToastHost/>` once at your app root, then call `toast(...)` from
anywhere — an event handler, an effect, after a method resolves. Auto-dismisses;
returns a manual dismiss fn.

```tsx
import { toast, ToastHost } from "aio/ui";

export default function App() {
  return (
    <div>
      <ToastHost /> {/* … */}
    </div>
  );
}

// anywhere:
await cart.checkout();
toast("Order placed", { variant: "success" });
toast("Network error", { variant: "error", duration: 0 }); // sticky until dismissed
```

### Markdown

A safe, common-subset renderer (headings, bold/italic, code, links, images,
lists, blockquote, hr). It renders to AIR nodes — **not** an HTML string — so
text is auto-escaped and there's no raw-HTML/XSS passthrough; link and image
URLs are scheme-checked (`javascript:`/`data:` are dropped).

```tsx
<Markdown source={post.body} />;
```

For full CommonMark (tables, footnotes, syntax highlighting), mount a library as
a [React island](react-islands.md) — this covers the 90% content apps re-roll.

## Philosophy

This kit is intentionally minimal — enough to build a real dashboard without
importing anything, not a replacement for a full design system. When you need a
richer component (a charting library, a data grid), mount it as a
[React island](react-islands.md) — aio can host React components without
depending on React.

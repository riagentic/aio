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

Everything keys off `--aio-*` tokens with a light + dark default (follows
`prefers-color-scheme`). Reskin by overriding tokens in your own CSS:

```css
:root {
  --aio-accent: #7c3aed;
  --aio-radius: 12px;
}
```

## Components

Every component accepts `class`, `style`, and any extra DOM attribute
(`id`, `aria-*`, `data-*`) as an escape hatch — they never fight your markup.

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
</Field>
```

### Table

A basic data table. Columns declare a `key`, an optional `header`, and an
optional `render`:

```tsx
const columns = [
  { key: "name", header: "Name" },
  { key: "role", header: "Role" },
  { key: "actions", header: "", render: (u) => <Button size="sm" onClick={() => users.remove(u.id)}>×</Button> },
];

<Table columns={columns} rows={users.list} getKey={(u) => u.id} empty="No users yet" onRowClick={(u) => open(u)} />
```

For very large datasets, drive `rows` with
[`useVirtualList`](air-advanced.md) and pass the visible window — the table
itself stays deliberately simple.

### Modal

A dialog with backdrop, Escape-to-close, backdrop-click-to-close, and ARIA —
the primitive apps otherwise re-roll per form. The Escape listener attaches to
AIR's render document, so it works under `testUI`/SSR too.

```tsx
<Modal open={ui.confirmOpen} onClose={() => ui.closeConfirm()} title="Delete?"
  footer={<Button variant="danger" onClick={() => row.delete()}>Delete</Button>}>
  This can't be undone.
</Modal>
```

Pass `dismissable={false}` to require an explicit action (no Escape/backdrop close).

### Card + layout — `Card`, `Stack`, `Row`, `Spinner`

```tsx
<Card title="Revenue" footer="updated just now">
  <Stack gap={8}>
    <Row gap={12} align="center"><b>$12,480</b><Spinner /></Row>
  </Stack>
</Card>
```

## Philosophy

This kit is intentionally minimal — enough to build a real dashboard without
importing anything, not a replacement for a full design system. When you need a
richer component (a charting library, a data grid), mount it as a
[React island](react-islands.md) — aio can host React components without
depending on React.

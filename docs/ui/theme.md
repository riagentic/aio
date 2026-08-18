# The default theme

Every aio app has a stylesheet before anyone writes one. Cells + a component +
`aio.run()` gives you a finished-looking app — typography, colour in light and
dark, forms, tables, code, cards — and the colour is **your app's**, derived
from its identity, so two aio apps side by side do not look like the same app.

```ts
await aio.run({ appId: "notekeeper" });
// → a themed app. No style.css anywhere in the project.
```

## It cannot fight you

Every rule lives in `@layer aio`. An **unlayered** rule — that is, any rule in
your own `style.css` — beats every layered rule regardless of specificity:

```css
/* style.css — wins. No !important, no ordering trick. */
button {
  background: #111;
  color: #fff;
}
```

So the theme is never something to work around. Write CSS as if it were not
there and it will get out of the way.

## Rebrand with one variable

The whole palette derives from a handful of custom properties. Set them in your
own CSS (or on a subtree — they cascade):

```css
:root {
  --aio-accent: #6d5efc; /* fills: primary buttons, focus ring, checkboxes */
  --aio-accent-ink: #4a3fd0; /* accent as TEXT: links, badges */
  --aio-r-2: 4px; /* squarer controls */
  --aio-font: "Inter", system-ui, sans-serif;
  --aio-page: 60rem; /* narrower page container */
}
```

| Token                                            | What it colours                      |
| ------------------------------------------------ | ------------------------------------ |
| `--aio-bg` · `--aio-surface` · `--aio-surface-2` | page, cards, insets                  |
| `--aio-text` · `--aio-muted` · `--aio-border`    | body copy, secondary copy, hairlines |
| `--aio-accent` · `--aio-on-accent`               | accent fill and the ink on it        |
| `--aio-accent-ink`                               | the accent as text (links, badges)   |
| `--aio-danger` · `--aio-ok` · `--aio-warn`       | status                               |
| `--aio-r-1…4` · `--aio-s-1…6` · `--aio-page`     | radii, spacing, page width           |
| `--aio-shadow-1/2` · `--aio-ring` · `--aio-tint` | elevation, focus, accent wash        |

Two accent tokens rather than one, because a fill and a label answer different
questions: a fill is measured against its own text, text is measured against the
page. A vivid lime button is correct; vivid lime link text on a near-white page
is not.

## What it styles

Semantic HTML, so you get the look by writing the markup you would write anyway:
headings, paragraphs, links, lists, `blockquote`, `hr`, `code`/`pre`, `kbd`,
`table`, `form` controls, `fieldset`, `details`, `dialog`, `progress`, `img`.

Writing `<main>` opts into a page container (centred, `--aio-page` wide,
padded). Apps that want full bleed — a canvas, a map, a game — simply do not use
it. A `<header>` or `<footer>` at the top level becomes a full-bleed bar whose
_content_ lines up with `<main>`.

Five classes are worth knowing:

| Class    | What it does                                   |
| -------- | ---------------------------------------------- |
| `.card`  | surface + border + radius + soft shadow        |
| `.stack` | vertical flex with a gap                       |
| `.row`   | horizontal flex, centred, wrapping, with a gap |
| `.grid`  | responsive auto-fit grid (min 15rem columns)   |
| `.badge` | small accent pill                              |
| `.muted` | secondary text colour                          |

Buttons: the default is quiet; `.primary` is the accent one (as is a
`<button type="submit">`); `.ghost` and `.danger` are the other two you always
end up needing.

## Dark mode

Automatic, via `prefers-color-scheme` — there is nothing to wire. Both schemes
are checked against WCAG AA for body text, accent text and accent fills across
the whole hue wheel (`tests/app-theme.test.ts`), so no app's generated colour
can be the unreadable one.

## Turning it off

```ts
await aio.run({ ui: { theme: "none" } });
```

Emits nothing but the box-model baseline (`box-sizing`, `body{margin:0}`), which
is not part of the theme and never goes away. Reach for this when the app ships
a full design system and the only thing the default can contribute is bytes —
not to override it, which needs no switch at all.

## Where the colour comes from

The accent hue is a hash of the app's `appId` — the same hash that draws the
[default icon](../build/targets.md), so an app's taskbar icon, its
[themed title bar](../clients/electron.md#window-chrome-uichrome) and its
buttons are one colour the first time it runs. It follows identity rather than
`ui.title`, so a title that changes with the route does not recolour the app
mid-session.

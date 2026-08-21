# The default theme

aio ships a complete stylesheet — typography, colour in light and dark, forms,
tables, code, cards, a page shell — and the colour is **your app's**, derived
from its identity, so two aio apps side by side do not look like the same app.

**It is opt-in, in one word:**

```ts
await aio.run({ appId: "notekeeper", ui: { theme: "auto" } });
// → a themed app. No style.css anywhere in the project.
```

`am create` writes that line into every new app, so a scaffolded app is a
finished-looking product the first time it runs.

## Why opt-in, and not a default

An app brings CSS in more ways than a shell can see: a `style.css`, a `<style>`
in `ui.head`, a sheet the component itself renders, a CSS-in-JS runtime, a
design system it imports. A framework look that arrives on its own therefore
lands on top of styling aio has no way to detect.

A cascade layer is not enough to make that safe. Every rule does live in
`@layer aio`, and an **unlayered** rule — any rule in your own stylesheet —
beats a layered one regardless of specificity:

```css
/* style.css — wins. No !important, no ordering trick. */
button {
  background: #111;
  color: #fff;
}
```

But a layer only settles a _disagreement_. Where your CSS says **nothing** about
a property, the default applies unopposed — there is no competing declaration
for it to lose to. That is not theoretical: an app whose
`<main class="content">` set `padding` but no `max-width` inherited
`:where(main){max-width:72rem; margin-inline:auto}`, and its content pane
rendered as a centred column with an empty band beside it. The `padding` it
declared won; the two properties it never mentioned did not.

Worse than the layout damage is the confusion. A rule you did not write, which
is also not the browser default, is the hardest kind to track down. So aio's
look never arrives unasked: an app that never mentions `theme` renders with the
browser's own defaults, aio's two-rule baseline (`box-sizing`, `body{margin:0}`)
and nothing else that paints.

## Your stylesheet still owns the stage

Having opted in with `"auto"`, **the moment your app ships a `style.css` every
visual default steps aside.** Not "loses to yours where you disagree" — leaves.
What remains is the inert half: the `--aio-*` custom properties, which paint
nothing unless something references them.

```ts
// ui.theme: "auto", no style.css  → the full default look
// ui.theme: "auto", src/style.css → your CSS, plus the --aio-* variables. Nothing else.
```

So you start with a finished look, and the day you start styling, you style
everything — the way it would be without a framework.

Want both? `ui.theme: "full"` keeps the complete look alongside your CSS.

```ts
await aio.run({ cells: [app], ui: { theme: "full" } });
```

## Rebrand with one variable

The whole palette derives from a handful of custom properties. Set them in your
own CSS (or on a subtree — they cascade):

```css
:root {
  --aio-accent: #6d5efc; /* fills: primary buttons, focus ring, checkboxes */
  --aio-on-accent: #ffffff; /* the ink ON that fill */
  --aio-accent-ink: #4a3fd0; /* the accent as TEXT: links, badges */
  --aio-r-2: 4px; /* squarer controls */
  --aio-font: "Inter", system-ui, sans-serif;
  --aio-page: 60rem; /* narrower page container */
}
```

**Set all three.** `--aio-ring` and `--aio-tint` are `color-mix`es of the fill
and follow it, but the two INK tokens are contrast-solved at generation time
against the app's own hue — they are literals, not derivations. Change only the
fill and your buttons keep the ink chosen for the old colour, which is how an
accessible palette turns into white-on-yellow. The generated palette is checked
against WCAG AA across the hue wheel; a hand-set one is yours to check.

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

## Building **on** the default, safely

There is a third thing you might want: you like the default look and want to
extend it rather than replace it. Done through the framework, that puts your
app's appearance in a file you do not control and have never read — and a
framework upgrade can then move your UI with no compile error and no failing
test. That is not hypothetical; it is how `:where(main){max-width:72rem}` halved
a real app's content pane.

So aio does not ask you to trust it. It hands the stylesheet over:

```sh
am theme adopt      # → src/aio-theme.css, imported by your style.css
```

From that moment the rules are **yours**: a normal stylesheet in your repo and
your git history, that you can read, edit and diff, and that no aio version can
change. Adopting also needs no extra switch — your app now _has_ a stylesheet,
which is exactly the condition `ui.theme: "auto"` steps aside for, so there is
exactly one copy of the theme and it is the one you own.

The adopted file keeps its `@layer aio` wrapper, so your own unlayered rules
still beat it without `!important` — you override a piece without deleting it. A
second `adopt` refuses rather than discarding your edits (`--force`, after a
diff, is the way through).

The alternative — `ui.theme: "full"` — is the _living_ version of the same idea:
aio's current look applied alongside your CSS. It is honest about what it is: it
moves when the framework moves. That is bounded (an app pins an exact aio
version, so it can only move on a deliberate `am pin`), but if you want the look
frozen, adopt it.

| You want                            | Do this                       |
| ----------------------------------- | ----------------------------- |
| Nothing of aio's in your way        | nothing — that is the default |
| A finished look, no CSS to write    | `ui.theme: "auto"`            |
| Your own design, no interference    | nothing, or write `style.css` |
| To build ON aio's look, frozen      | `am theme adopt`              |
| To build ON aio's look, tracking it | `ui.theme: "full"`            |

## The four settings

| `ui.theme`           | With no `style.css`                | With your own `style.css`              |
| -------------------- | ---------------------------------- | -------------------------------------- |
| `"tokens"` (default) | **inert `--aio-*` variables only** | **inert `--aio-*` variables only**     |
| `"auto"`             | the full default look              | **inert `--aio-*` variables only**     |
| `"full"`             | the full default look              | the full default look, alongside yours |
| `"none"`             | **no aio CSS at all**              | **no aio CSS at all**                  |

```ts
await aio.run({ ui: { theme: "none" } });
```

`"none"` is the whole off switch: no look, no variables, and not even the
two-rule box-model baseline (`*{box-sizing:border-box}`, `body{margin:0}`) that
every other setting carries. Reach for it when you are bringing an existing
stylesheet and want aio's hands off the page entirely — `border-box` on `*` is a
real layout change to a sheet written against `content-box`.

The trade is that you inherit the browser's own defaults, including
`body{margin:8px}` — the white frame around the page that the baseline exists to
remove. That is the correct trade for a port and the wrong one for a new app,
which is why it is one word and not the default.

Why the variables survive by default: a custom property that nothing references
renders nothing, so they cannot move a box or paint a pixel on their own.
Keeping them means `ui.chrome: "themed"`'s title bar (which reads
`var(--aio-…, fallback)`) stays coherent with the rest of your app, and you can
reference a token deliberately if you want one.

## Where the colour comes from

The accent hue is a hash of the app's `appId` — the same hash that draws the
[default icon](../build/targets.md), so an app's taskbar icon, its
[themed title bar](../clients/electron.md#window-chrome-uichrome) and its
buttons are one colour the first time it runs. It follows identity rather than
`ui.title`, so a title that changes with the route does not recolour the app
mid-session.

# Tailwind, PostCSS, Sass — a CSS toolchain

aio runs your CSS build for you. One key in `deno.json`:

```jsonc
{
  "build": {
    "css": "deno run -A npm:@tailwindcss/cli -i src/app.css -o src/style.css"
  }
}
```

That command runs **before every dev reload** and **before every build**. Edit a
class in your TSX, save, and the page you see is styled by the CSS that edit
produced.

Nothing changes for an app that omits the key.

## Why this is only one key

The hard part was already done. `docs/ui/theme.md` promises that the generated
theme **steps fully aside the moment `src/style.css` exists** — not "loses where
you disagree", _leaves_. Tailwind's output **is** a `style.css`. So the two fit
together with no adapter: point the tool at `style.css` and the default theme
gets out of the way, which is exactly what you want.

## Tailwind, end to end

Tailwind v4 needs `tailwindcss` resolvable as a node package, so the app's
`deno.json` needs `nodeModulesDir`:

```jsonc
{
  "appId": "myapp",
  "nodeModulesDir": "auto",
  "imports": {
    "aio": "jsr:@riagentic/aio@1.0.0-alpha77",
    "tailwindcss": "npm:tailwindcss@^4"
  },
  "build": {
    "css": "deno run -A npm:@tailwindcss/cli -i src/app.css -o src/style.css"
  }
}
```

`src/app.css` — your source, one line to start:

```css
@import "tailwindcss";
```

`src/style.css` — **generated. Do not edit it, and add it to `.gitignore`.**

Then write classes as usual:

```tsx
export function App() {
  return (
    <div class="flex items-center gap-4 rounded-lg bg-slate-900 p-6 text-slate-100">
      <h1 class="text-xl font-semibold">Hello</h1>
    </div>
  );
}
```

`class`, not `className` — both work in AIR, and `class` is what Tailwind's own
docs and every editor extension expect.

Measured: Tailwind v4 rebuilds this in ~30 ms, so the dev loop stays a save and
a reload.

### Content detection

Tailwind v4 scans the project automatically and finds `.tsx` on its own. If you
keep components somewhere unusual, say so in `src/app.css`:

```css
@import "tailwindcss";
@source "../components";
```

## PostCSS, Sass, anything else

The key is a command, not a Tailwind integration. Anything that writes
`src/style.css` works:

```jsonc
"build": { "css": "deno run -A npm:sass src/app.scss src/style.css" }
```

Use an **array** when an argument contains spaces:

```jsonc
"build": { "css": ["deno", "run", "-A", "npm:sass", "src/main.scss", "src/style.css"] }
```

There is no shell. `deno task` already exists for pipes and `&&`, and a config
value that reaches a shell can do whatever a shell can.

## What happens when it fails

- **A build fails.** An unstyled artifact must not be shippable, so a non-zero
  exit stops `deno task build` and prints the tool's own output.
- **Dev keeps serving.** A typo in a class must not kill the dev server you are
  using to fix it. The error is logged, the previous stylesheet keeps serving,
  and the next save tries again.

That split is the only direction aio allows: dev is never more permissive about
what _ships_.

- **The command is missing** (`npm:@tailwindcss/cli` not installed, a script not
  executable): the error names the command and the reason. It is never skipped
  silently — a CSS step that quietly did not run is a build that succeeds and an
  app that ships with the wrong stylesheet.

## Paths

`build.css` runs with the **project root** as its working directory, like
`compile.include`. So `-o src/style.css`, not `-o style.css` — the stylesheet
belongs beside your app entry, which is where dev serves it from and where the
build reads it.

## Using the theme and Tailwind together

Shipping a `style.css` turns the default theme off completely. If you want
Tailwind _and_ aio's palette, import the theme's tokens into your own sheet —
they are plain custom properties (`--aio-accent`, `--aio-surface`, `--aio-text`
…) and Tailwind v4 reads them directly:

```css
@import "tailwindcss";

@theme {
  --color-accent: var(--aio-accent);
  --color-surface: var(--aio-surface);
}
```

## Scoped styles

aio has one global stylesheet, so class names are global. Tailwind sidesteps
that question entirely — utility classes are shared on purpose. If you write
your own classes alongside, prefix them by component (`.timeline-track`, not
`.track`): two components that pick the same name silently share rules, and the
symptom is a visual one no test sees.

## See also

- [The default theme](./theme.md) — what steps aside, and when
- [The component kit](./kit.md) — ~30 components, if you would rather not style
  at all

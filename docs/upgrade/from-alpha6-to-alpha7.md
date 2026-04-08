# Upgrade from v1.0.0-alpha6 to v1.0.0-alpha7

> **Note:** `feature()` was renamed to `cell()` in alpha11. See
> [upgrade guide](from-alpha10-to-alpha11.md).

### Breaking changes

**Renderer exports removed from `mod.ts`**

`mod.ts` no longer re-exports renderer primitives. Import from the dedicated
barrel modules instead:

```ts
// BEFORE (alpha6) — deep internal imports
import { onCleanup, onMount, useRef } from "dep/aio/src/aio-renderer.ts";

// AFTER (alpha7) — clean barrel imports
import { effect, onCleanup, onMount, signal, useRef } from "aio/air";
// or for React adapter:
import { useFeature, useLocal } from "aio/react";
```

**`middleware.ts` and `lint.ts` extracted from `aio.ts`**

If you imported these internals directly from `aio.ts`, update paths:

```ts
// BEFORE
import { composeMiddleware } from "dep/aio/src/aio.ts";
import { lint } from "dep/aio/src/aio.ts";

// AFTER
import { composeMiddleware } from "dep/aio/src/middleware.ts";
import { lint } from "dep/aio/src/lint.ts";
```

Public API via `import from "aio"` is unchanged — these are re-exported.

### Non-breaking additions

- **Type-safe `send`** — `useFeature` infers method signatures from the feature
  definition. `send.methodName(...)` is fully typed. No code changes needed.
- **`aio/air` and `aio/react` barrel exports** — one import for all primitives.
  Old imports continue to work.
- **React compat hooks** — `useState`, `useEffect`, `useCallback`, `useMemo`
  available from `aio/react`. Drop-in replacements for React muscle memory.
- **12 bug fixes (AIO-55..70)** — proxy ownKeys, signal equality, ref callbacks,
  JSX types, useLocal patch, useFeature inference, CJS stubs, aio:// scheme.

### Upgrade steps

1. Update `deno.json`: `"aio": "jsr:@riagentic/aio@1.0.0-alpha7"`
2. Update task commands:
   `"am": "deno run -A jsr:@riagentic/aio@1.0.0-alpha7/src/am"`
3. Replace any deep renderer imports with `aio/air` or `aio/react` barrel
   imports. `deno check` will flag broken paths.
4. Run `deno install && deno task dev`

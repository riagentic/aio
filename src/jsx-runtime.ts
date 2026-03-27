// JSX automatic runtime for AIO renderer.
// Provides jsx/jsxs/Fragment so esbuild's `jsxImportSource: "aio"` works
// without explicit `import { h } from "aio"` in every component file.

import { Fragment, h } from "./vdom.ts";

export { Fragment };

/** Automatic JSX transform — called by esbuild for single-child elements */
export function jsx(
  tag: string | typeof Fragment | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown> | null,
  key?: string | number,
): ReturnType<typeof h> {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) rest.key = key;
  const kids = children == null
    ? []
    : Array.isArray(children)
    ? children
    : [children];
  return h(tag as string, rest, ...kids);
}

/** Automatic JSX transform — called by esbuild for multi-child elements */
export const jsxs = jsx;

import { Fragment, h } from "./vdom.ts";
import type { VChild, VNode } from "./vdom.ts";

/**
 * Conditional renderer with TypeScript narrowing.
 * When `when` is truthy, calls the child render function with the narrowed value.
 * When falsy, renders `fallback` (or nothing).
 */
export function Show<T>(props: {
  when: T | undefined | null | false | 0 | "";
  fallback?: VChild;
  children?: ((value: T) => VChild) | VChild[];
}): VNode | null {
  const { when: condition, fallback, children } = props;

  if (condition) {
    // JSX wraps function children in array — unwrap single-function arrays
    const childFn = typeof children === "function"
      ? children
      : Array.isArray(children) && children.length === 1 &&
          typeof children[0] === "function"
      ? children[0] as (value: T) => VChild
      : null;
    if (childFn) {
      const result = childFn(condition as T);
      if (result == null || typeof result === "boolean") return null;
      if (typeof result === "object" && "tag" in (result as VNode)) {
        return result as VNode;
      }
      return h(Fragment, null, result as VChild);
    }
    if (Array.isArray(children) && children.length > 0) {
      return h(Fragment, null, ...children);
    }
    return null;
  }

  if (fallback == null || typeof fallback === "boolean") return null;
  if (typeof fallback === "object" && "tag" in (fallback as VNode)) {
    return fallback as VNode;
  }
  return h(Fragment, null, fallback);
}

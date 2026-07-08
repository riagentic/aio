// dom-snapshot.ts — DOM tree walker: visibility, selector gen, semantic snapshot. Browser/Electron only.
import type { UINode } from "./dom-inspector-types.ts";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "LINK",
  "META",
  "HEAD",
]);
const MAX_TEXT = 200;
const MAX_VALUE = 500;
const INTERACTIVE_TAGS = new Set([
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "A",
]);
const MAX_DEPTH = 50;
const MAX_NODES = 5000;

/** Returns true if the element is rendered and takes up space in the viewport. */
export function isVisible(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  const htmlEl = el as HTMLElement;

  // offsetParent is null for hidden elements — except BODY and position:fixed
  if (htmlEl.offsetParent === null && tag !== "BODY") {
    const style = getComputedStyle(el);
    if (style.position !== "fixed") return false;
  }

  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.opacity === "0") return false;

  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Generates a unique CSS selector that resolves back to this exact element. */
export function uniqueSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const comp = el.getAttribute("data-component");
  if (comp) return `[data-component="${CSS.escape(comp)}"]`;
  return nthOfTypePath(el);
}

function nthOfTypePath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node.tagName !== "HTML") {
    const parent: Element | null = node.parentElement;
    if (!parent) break;

    const tag = node.tagName.toLowerCase();
    const nodeTag = node.tagName;
    const siblings = Array.from(parent.children).filter(
      (c: Element) => c.tagName === nodeTag,
    );
    const idx = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length === 1 ? tag : `${tag}:nth-of-type(${idx})`);
    node = parent;
  }

  return parts.join(" > ");
}

/** Walk the DOM tree and produce a semantic UINode[] array. */
export function snapshotDOM(
  root: Element = document.body,
  includeInvisible = false,
): UINode[] {
  const ctx = { nodeCount: 0 };
  return walkChildren(root, includeInvisible, 0, ctx);
}

function walkChildren(
  parent: Element,
  includeInvisible: boolean,
  depth: number,
  ctx: { nodeCount: number },
): UINode[] {
  const nodes: UINode[] = [];
  for (const child of parent.children) {
    if (ctx.nodeCount >= MAX_NODES) break;
    const node = walkElement(child, includeInvisible, depth, ctx);
    if (node) nodes.push(node);
  }
  return nodes;
}

function walkElement(
  el: Element,
  includeInvisible: boolean,
  depth: number,
  ctx: { nodeCount: number },
): UINode | null {
  if (ctx.nodeCount >= MAX_NODES) return null;
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return null;

  const visible = isVisible(el);
  if (!visible && !includeInvisible) return null;

  ctx.nodeCount++;

  // SVG: keep root, skip internals
  if (tag === "SVG") return buildNode(el, visible, []);

  // Depth guard: prevent stack overflow on deeply nested DOM
  if (depth >= MAX_DEPTH) return buildNode(el, visible, []);

  const children = walkChildren(el, includeInvisible, depth + 1, ctx);

  // Collapse pure wrapper divs (div/span with no identity, single child)
  if (isWrapper(el, tag) && children.length === 1) return children[0] ?? null;

  return buildNode(el, visible, children);
}

function isWrapper(el: Element, tag: string): boolean {
  if (tag !== "DIV" && tag !== "SPAN") return false;
  if (el.id) return false;
  if (el.classList.length > 0) return false;
  if (el.getAttribute("data-testid")) return false;
  if (el.getAttribute("data-component")) return false;
  if (el.getAttribute("role")) return false;
  if (directText(el).length > 0) return false;
  return true;
}

function buildNode(el: Element, visible: boolean, children: UINode[]): UINode {
  const tag = el.tagName.toLowerCase();
  const htmlEl = el as HTMLInputElement & HTMLAnchorElement & HTMLImageElement;

  const aria: Record<string, string> = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith("aria-")) aria[attr.name.slice(5)] = attr.value;
  }

  const dataset: Record<string, string> = {};
  for (const attr of el.attributes) {
    if (
      attr.name.startsWith("data-") &&
      attr.name !== "data-testid" &&
      attr.name !== "data-component"
    ) {
      dataset[attr.name.slice(5)] = attr.value;
    }
  }

  const text = directText(el);
  const classes = el.classList.length > 0
    ? Array.from(el.classList)
    : undefined;

  const node: UINode = { tag, selector: uniqueSelector(el), visible };

  if (el.id) node.id = el.id;
  const testId = el.getAttribute("data-testid");
  if (testId) node.testId = testId;
  const comp = el.getAttribute("data-component");
  if (comp) node.component = comp;
  const role = el.getAttribute("role");
  if (role) node.role = role;

  if (text) node.text = text.slice(0, MAX_TEXT);
  if (classes) node.classes = classes;
  if (Object.keys(aria).length > 0) node.aria = aria;
  if (Object.keys(dataset).length > 0) node.dataset = dataset;

  if (INTERACTIVE_TAGS.has(el.tagName)) {
    if (htmlEl.disabled) node.disabled = true;
    if ("checked" in htmlEl && htmlEl.checked !== undefined) {
      node.checked = htmlEl.checked;
    }
    if (htmlEl.value !== undefined && htmlEl.value !== "") {
      node.value = String(htmlEl.value).slice(0, MAX_VALUE);
    }
    if (htmlEl.href) node.href = htmlEl.href;
    if (htmlEl.placeholder) node.placeholder = htmlEl.placeholder;
  }

  if (htmlEl.src) node.src = htmlEl.src;
  if (children.length > 0) node.children = children;

  return node;
}

/** Extract direct (non-element-child) text content, trimmed. */
function directText(el: Element): string {
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
  }
  return text.trim();
}

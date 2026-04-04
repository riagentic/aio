// dom-interact.ts — UI interaction dispatcher: click, type, select, focus, blur, scroll, hover.
import type { InteractCommand, InteractResult } from "./dom-inspector-types.ts";
import { isVisible } from "./dom-snapshot.ts";

type Base = { selector: string; action: string };
const B = { bubbles: true };

function _desc(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = el.classList.length > 0
    ? "." + Array.from(el.classList).join(".")
    : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

function _doClick(el: Element, base: Base): InteractResult {
  if (typeof (el as HTMLElement).focus === "function") {
    (el as HTMLElement).focus();
  }
  el.dispatchEvent(new PointerEvent("pointerdown", B));
  el.dispatchEvent(new MouseEvent("mousedown", B));
  el.dispatchEvent(new PointerEvent("pointerup", B));
  el.dispatchEvent(new MouseEvent("mouseup", B));
  (el as HTMLElement).click();
  return { ok: true, ...base };
}

function _doType(
  el: Element,
  cmd: InteractCommand,
  base: Base,
  desc: string,
): InteractResult {
  if (
    !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)
  ) {
    return { ok: false, ...base, error: `${desc} is not an input or textarea` };
  }
  // Clear first if explicitly requested (opt-in, not default)
  if (cmd.options?.clear === true) el.value = "";
  el.value = cmd.value ?? "";
  el.dispatchEvent(new Event("input", B));
  el.dispatchEvent(new Event("change", B));
  return { ok: true, ...base };
}

function _doSelect(
  el: Element,
  cmd: InteractCommand,
  base: Base,
  desc: string,
): InteractResult {
  if (el instanceof HTMLSelectElement) {
    const v = cmd.value ?? "";
    el.value = v;
    // Verify the option exists — select resets to "" if no match
    if (v !== "" && el.value !== v) {
      return { ok: false, ...base, error: `no option matching "${v}"` };
    }
    el.dispatchEvent(new Event("change", B));
    return { ok: true, ...base };
  }
  const child = el.querySelector(
    `[data-value="${CSS.escape(cmd.value ?? "")}"]`,
  );
  if (child) {
    (child as HTMLElement).click();
    return { ok: true, ...base };
  }
  return {
    ok: false,
    ...base,
    error: `${desc} is not a <select> and no [data-value] child found`,
  };
}

/** Find element, validate, and dispatch interaction. */
export function interact(cmd: InteractCommand): InteractResult {
  const base: Base = { selector: cmd.selector, action: cmd.action };
  let el: Element | null;
  try {
    el = document.querySelector(cmd.selector);
  } catch (e) {
    return {
      ok: false,
      ...base,
      error: `invalid selector: ${(e as Error).message}`,
    };
  }

  if (!el) return { ok: false, ...base, error: "not found" };
  if (!isVisible(el)) return { ok: false, ...base, error: "not visible" };

  const desc = _desc(el);
  const htmlEl = el as HTMLInputElement;
  if (["click", "type", "select"].includes(cmd.action) && htmlEl.disabled) {
    return { ok: false, ...base, error: "disabled" };
  }

  switch (cmd.action) {
    case "click":
      return _doClick(el, base);
    case "type":
      return _doType(el, cmd, base, desc);
    case "select":
      return _doSelect(el, cmd, base, desc);
    case "focus":
      (el as HTMLElement).focus();
      el.dispatchEvent(new FocusEvent("focus", B));
      return { ok: true, ...base };
    case "blur":
      (el as HTMLElement).blur();
      el.dispatchEvent(new FocusEvent("blur", B));
      return { ok: true, ...base };
    case "scroll":
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true, ...base };
    case "hover":
      el.dispatchEvent(new PointerEvent("pointerenter", B));
      el.dispatchEvent(new MouseEvent("mouseover", B));
      el.dispatchEvent(new PointerEvent("pointermove", B));
      el.dispatchEvent(new MouseEvent("mousemove", B));
      return { ok: true, ...base };
    default:
      return { ok: false, ...base, error: `unknown action: ${cmd.action}` };
  }
}

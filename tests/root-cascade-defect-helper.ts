// happy-dom 17.6.3's custom-property cascade, put back on a window whose
// engine has since been fixed.
//
// MEASURED (happy-dom 17.6.3, report 9 §1): any selector that BEGINS with
// `:root` is taken to match the root element, whatever follows it — so a
// custom property on the root answers the LAST such declaration in the
// sheets. RE-MEASURED (happy-dom 20.14.5): fixed; `:root[data-p="b"]`,
// `:root:not(.z)` and `:root .card` no longer leak onto a root they do not
// match.
//
// The guard against that engine (src/air/contrast-cascade.ts) stays: a
// document an app makes from its own `"happy-dom"` import (which may still
// pin 17) and hands to `testUI`/`testComponent` is that engine.
// Its tests used to get the defect for free from the real window; this is the
// same defect, stated once, so they keep proving the guard on any version.

// deno-lint-ignore-file no-explicit-any

/** Make `win.getComputedStyle(<html>)` answer custom properties the way
 *  happy-dom 17.6.3 does. Everything else is the window's own answer. */
export function breakRootCascade(win: any): void {
  const real = win.getComputedStyle.bind(win);
  const lastRootDeclaration = (prop: string): string => {
    let value = "";
    for (const sheet of win.document.styleSheets) {
      for (const rule of sheet.cssRules) {
        const v = rule.selectorText?.startsWith(":root")
          ? rule.style.getPropertyValue(prop)
          : "";
        if (v) value = v;
      }
    }
    return value;
  };
  win.getComputedStyle = (el: any, ...rest: unknown[]) => {
    const style = real(el, ...rest);
    if (el !== win.document.documentElement) return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === "getPropertyValue") {
          return (prop: string) =>
            (prop.startsWith("--") && lastRootDeclaration(prop)) ||
            target.getPropertyValue(prop);
        }
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
}

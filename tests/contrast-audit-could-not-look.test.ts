// Two field findings where the colour audit reported "could not look" as a
// finding (risoto §9, §12): a gradient fill it read as transparent, and a theme
// switch it measured mid-transition. Both must be skipped — and the audit must
// stay loud about a real violation right beside them.
import { assert, assertEquals } from "@std/assert";
import {
  _resetContrastAudit,
  auditContrast,
} from "../src/air/contrast-audit.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { closeWindow } from "../src/testing/close-window.ts";

async function inHappyDom(css: string, html: string) {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "https://x.test" });
  win.document.body.innerHTML = `<style>${css}</style>${html}`;
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (m: string) => warns.push(m);
  try {
    setDevModeOverride(true);
    _resetContrastAudit();
    const findings = auditContrast(
      win.document.querySelector(".root") as unknown as Element,
    );
    return { findings, warns };
  } finally {
    console.warn = real;
    await closeWindow(win);
  }
}

Deno.test("contrast: a gradient fill is not read as the panel behind it", async () => {
  // The measured shape: #1c2024 ink on a warm gradient, over a #212225 panel.
  // Reading `background-color` alone reported 1.03:1.
  const onGradient = await inHappyDom(
    ".root{background:#212225}" +
      ".row{background:linear-gradient(100deg,#db9269,#df8f73);color:#1c2024}",
    `<div class="root"><div class="row">cursor row</div></div>`,
  );
  assertEquals(onGradient.findings, 0, onGradient.warns.join("\n"));
  // …on an ANCESTOR too: the layer under the text is still the gradient.
  const underGradient = await inHappyDom(
    ".root{background:#212225}.row{background:linear-gradient(#db9269,#df8f73)}" +
      ".lab{color:#1c2024}",
    `<div class="root"><div class="row"><span class="lab">x</span></div></div>`,
  );
  assertEquals(underGradient.findings, 0, underGradient.warns.join("\n"));
  // …and a real violation on a plain panel beside it still fires.
  const real = await inHappyDom(
    ".root{background:#212225}.row{background:linear-gradient(#db9269,#df8f73)}" +
      ".lab{color:#1c2024}",
    `<div class="root"><div class="row">x</div><span class="lab">dark on dark</span></div>`,
  );
  assertEquals(real.findings, 1, real.warns.join("\n"));
});

/** A hand-built tree whose document reports the given animations. */
function movingDom(animated: (els: Record<string, unknown>) => unknown[]) {
  const win = {
    getComputedStyle: (e: { _id: string }) => ({
      getPropertyValue: (p: string) =>
        (({
          page: { "background-color": "rgb(232, 232, 236)" },
          // The reported frame: a transitioned `color` still at its old
          // (dark theme) value, on the new light panel.
          head: { "color": "rgb(242, 178, 140)", "font-size": "14px" },
          still: { "color": "rgb(242, 243, 245)", "font-size": "14px" },
        }) as Record<string, Record<string, string>>)[e._id]?.[p] ?? "",
    }),
  };
  const els: Record<string, Record<string, unknown>> = {};
  const doc = { defaultView: win, getAnimations: () => animated(els) };
  for (const id of ["page", "head", "still"]) {
    els[id] = {
      _id: id,
      tagName: id === "page" ? "DIV" : "SPAN",
      parentElement: null,
      children: [],
      childNodes: id === "page" ? [] : [{ nodeType: 3, nodeValue: id }],
      getAttribute: (n: string) => n === "class" ? id : null,
      ownerDocument: doc,
    };
  }
  for (const id of ["head", "still"]) {
    els[id]!.parentElement = els.page;
    (els.page!.children as unknown[]).push(els[id]);
  }
  return els;
}

Deno.test("contrast: an element mid colour-transition is skipped, then audited once it lands", async () => {
  setDevModeOverride(true);
  _resetContrastAudit();
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: string) => warns.push(m);
  let land!: () => void;
  const finished = new Promise<void>((r) => land = r);
  let moving = true;
  try {
    const els = movingDom((e) =>
      moving
        ? [
          // A transform on the page moves no colour: it must not silence it.
          {
            effect: {
              target: e.page,
              getKeyframes: () => [{ transform: "x" }],
            },
          },
          {
            effect: {
              target: e.head,
              getKeyframes: () => [{ color: "a", offset: 0 }, { color: "b" }],
              getComputedTiming: () => ({ endTime: 200 }),
            },
            finished,
          },
          // An infinite colour pulse elsewhere never settles: it must not hold
          // the re-run hostage.
          {
            effect: {
              target: {},
              getKeyframes: () => [{ backgroundColor: "a" }],
              getComputedTiming: () => ({ endTime: Infinity }),
            },
            finished: new Promise(() => {}),
          },
        ]
        : []
    );
    // `still` is a real 1.1:1 violation with nothing moving — it fires now.
    assertEquals(auditContrast(els.page as unknown as Element), 1);
    assert(warns[0]!.includes('class="still"'), warns[0]);
    assert(!warns.some((w) => w.includes('class="head"')), warns.join("\n"));
    // Once the transition lands, the skipped element is looked at.
    moving = false;
    land();
    await finished;
    await new Promise((r) => setTimeout(r, 800)); // past THROTTLE_MS
    assert(
      warns.some((w) => w.includes('class="head"')),
      `the deferred pass must audit what it skipped: ${warns.join("\n")}`,
    );
  } finally {
    console.warn = realWarn;
    _resetContrastAudit();
  }
});

Deno.test("contrast: an ancestor's background-colour animation skips its text", () => {
  setDevModeOverride(true);
  _resetContrastAudit();
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: string) => warns.push(m);
  try {
    const els = movingDom((e) => [{
      effect: {
        target: e.page,
        getKeyframes: () => [{ backgroundColor: "a" }],
      },
    }]);
    assertEquals(
      auditContrast(els.page as unknown as Element),
      0,
      warns.join("\n"),
    );
  } finally {
    console.warn = realWarn;
    _resetContrastAudit();
  }
});

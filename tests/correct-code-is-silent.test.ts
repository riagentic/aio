// Correct code must be SILENT.
//
// Fail-loud only works while the loud part is right. Every field report found
// dev warnings that fired on correct code — the re-render warning on typing,
// the label check on a nested input, `onMount` blamed for a method's reads, a
// same-value set, React's hooks hinting on every use — and each false alarm
// teaches people to ignore the next warning, which is the real one. They were
// fixed one by one; the CLASS was not.
//
// This is the class-level check. The example apps and every `am create`
// template are correct code by definition (they are what aio teaches), so a
// crawler boots each UI in dev mode — the strictest mode, every tripwire armed
// — clicks every button, types into every field and changes every select,
// three rounds over, and requires ZERO warnings and errors. A new warning
// that fires on the code aio itself teaches turns this red with its text.
import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { testUI } from "../src/cell-test.ts";
import { scaffold, TEMPLATES } from "../src/am/am-cmd-create.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname;

const EXAMPLES = [
  "counter",
  "todo",
  "contacts",
  // not "disk": it scans the REAL filesystem — a crawler clicking "up" to `/`
  // and then "open" starts a walk of the whole disk, which is the app working.
  "updates",
  "targets/browser",
  "targets/electron",
  "targets/android",
];

// deno-lint-ignore no-explicit-any
type Any = any;

/** Be a user: every control, a few rounds (a click can reveal new ones). */
// deno-lint-ignore no-explicit-any
async function crawl(ui: any): Promise<number> {
  let acted = 0;
  for (let round = 0; round < 3; round++) {
    const doc = ui.document;
    const controls = [
      ...doc.querySelectorAll(
        "button:not([disabled]), input:not([disabled]), textarea, select",
      ),
    ] as Any[];
    for (const el of controls) {
      if (!el.isConnected) continue; // a previous action removed it
      const tag = el.tagName.toLowerCase();
      const kind = (el.getAttribute("type") ?? "").toLowerCase();
      if (tag === "select") {
        const last = el.options?.[el.options.length - 1];
        if (last) el.value = last.value;
        el.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
      } else if (
        tag === "textarea" ||
        (tag === "input" &&
          !["checkbox", "radio", "file", "submit", "button"].includes(kind))
      ) {
        const set = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(el),
          "value",
        )?.set;
        set
          ? set.call(el, kind === "number" ? "3" : `x${round}`)
          : (el.value = `x${round}`);
        el.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
        el.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
      } else if (tag === "input" && kind === "file") {
        continue; // no file to give it
      } else {
        el.click();
      }
      acted++;
      await ui.settle();
    }
  }
  return acted;
}

/** Everything the app said on the console while `fn` ran. */
async function said(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  console.warn = (...a: unknown[]) =>
    void out.push(`warn: ${a.map(String).join(" ")}`);
  console.error = (...a: unknown[]) =>
    void out.push(`error: ${a.map(String).join(" ")}`);
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return out;
}

async function silentRun(
  label: string,
  appTsx: string,
): Promise<void> {
  const { default: App } = await import(appTsx);
  let acted = 0;
  const lines = await said(async () => {
    await using ui = await testUI(App);
    acted = await crawl(ui);
  });
  assertEquals(
    lines,
    [],
    `${label}: correct code printed a warning — a false alarm teaches people ` +
      `to ignore the real one. Fix the WARNING (or the example, if it is ` +
      `genuinely wrong):\n  ` + lines.join("\n  "),
  );
  if (acted === 0) throw new Error(`${label}: the crawler found nothing to do`);
}

for (const ex of EXAMPLES) {
  // aio-ok: silentRun() asserts the console is empty and the crawler acted
  Deno.test(`silent: example ${ex} — clicked, typed and selected through, nothing warns`, async () => {
    await silentRun(ex, join(REPO, "examples", ex, "src", "App.tsx"));
  });
}

for (const template of TEMPLATES) {
  const files = scaffold("silent-probe", template, true);
  if (!files["src/App.tsx"]) continue; // a template with no UI (cli, …)
  // aio-ok: silentRun() asserts the console is empty and the crawler acted
  Deno.test(`silent: am create --template=${template} — nothing warns`, async () => {
    const dir = await tempDir(`aio-silent-${template}-`);
    try {
      for (const [rel, text] of Object.entries(files)) {
        await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
        await Deno.writeTextFile(join(dir, rel), text);
      }
      // The `assets` template's button fetches `/media/hello.txt` from the
      // app's own server; testUI has none (tests/testui-relative-fetch). Stand
      // in for it: a relative path gets the scaffolded file, or a 404.
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
        typeof input === "string" && input.startsWith("/")
          ? Promise.resolve(
            files[input.slice(1)] !== undefined
              ? new Response(files[input.slice(1)])
              : new Response("not found", { status: 404 }),
          )
          : realFetch(input, init)) as typeof fetch;
      try {
        await silentRun(`template ${template}`, join(dir, "src", "App.tsx"));
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      await dropTempDir(dir);
    }
  });
}

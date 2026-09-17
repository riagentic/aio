// Tier-3 twin of tests/ui-harness-browser-parity.test.tsx — the SAME gestures
// through `am trigger` (the trojan trigger endpoint, src/air/ui-remote.ts) in a
// real headless Chromium, asserting the answers a real user's input produced
// (measured with CDP input). The in-process file proves happy-dom agrees; this
// one proves the shared trigger engine agrees inside the real browser, where
// the DOM does its own activation, sanitization and retargeting.
//
// Runs when a chromium/chrome binary is on the box; skipped (visibly)
// otherwise. Opt out with AIO_E2E=0.
import { assert, assertEquals } from "@std/assert";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";
import { cdpConnect } from "../src/media/cdp.ts";
import { stopChild } from "./stop-child.ts";

const ROOT = new URL("..", import.meta.url).pathname;

function findBrowser(): string | null {
  if (Deno.env.get("AIO_E2E") === "0") return null;
  const fromEnv = Deno.env.get("AIO_E2E_BROWSER");
  for (
    const c of fromEnv ? [fromEnv] : [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]
  ) {
    try {
      Deno.statSync(c);
      return c;
    } catch { /* not this one */ }
  }
  return null;
}
const BROWSER = findBrowser();

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A95 = "abcdefghijklmnopqrstuvwxyz".repeat(4).slice(0, 95);

const CELLS = `import { cell } from "aio";
export const probe = cell("probe", {
  state: { text: "" },
  methods: {
    setText(s, t: string) {
      s.text = t;
    },
  },
});
`;

const APP_TSX = `// deno-lint-ignore-file no-explicit-any
import { useRef } from "aio/air";
import { probe } from "./cells.ts";
const L = (s: string) => (globalThis as any).__log.push(s);
(globalThis as any).__log = [];
const sub = (tag: string) => (e: any) =>
  L(tag + "-submit" + (e.submitter ? "@" + e.submitter.id : ""));
export default function App() {
  const dlg = useRef<any>(null);
  return (
    <main>
      <input t="Cell" aria-label="cell" value={probe.text}
        onInput={(e: any) => probe.setText(e.currentTarget.value)} />
      <form onSubmit={sub("B1")}>
        <input t="B1In" aria-label="b1" />
        <button id="b1" t="B1Btn" type="submit" onClick={() => L("B1-click")}>s</button>
      </form>
      <form onSubmit={sub("B2")}>
        <input t="B2In" aria-label="b2" /><input t="B2In2" aria-label="b2b" />
      </form>
      <form onSubmit={sub("C")}>
        <textarea t="CArea" aria-label="c"
          onInput={(e: any) => L("C-input:" + JSON.stringify(e.currentTarget.value))} />
        <button type="submit">s</button>
      </form>
      <form onSubmit={sub("F")}>
        <input t="FIn" aria-label="f" />
        <button type="submit" disabled>s</button>
      </form>
      <form onSubmit={sub("D")}>
        <input t="DIn" aria-label="d" onChange={(e: any) => L("D-change:" + e.currentTarget.value)} />
        <button t="DBtn" type="button" onClick={() => L("D-click")}>b</button>
      </form>
      <input id="ci" t="Commit" aria-label="commit" onInput={() => {}}
        onChange={(e: any) => L("change:" + e.currentTarget.value)} />
      <button id="cb" t="Go" type="button"
        onClick={() => L("click active=" + document.activeElement?.id)}>go</button>
      <input t="Fid" aria-label="fid"
        onKeyDown={(e: any) => L(["keydown", e.code, e.keyCode].join(" "))}
        onKeyPress={(e: any) => L(["keypress", e.code, e.keyCode].join(" "))}
        {...({ onBeforeInput: (e: any) => L(["beforeinput", e.inputType, e.data ?? ""].join(" ").trim()) } as any)}
        onInput={(e: any) => L(["input", e.constructor.name, e.inputType, e.data].join(" "))} />
      <input t="Num" aria-label="num" type="number" />
      <input t="When" aria-label="when" type="date" />
      <button t="Dbl" type="button" onClick={() => L("click")} onDblClick={(e: any) => L("dbl" + e.detail)}>d</button>
      <div t="Zone" role="group" onKeyDown={() => {}}
        onPointerOver={() => L("pointerover")} onPointerEnter={() => L("pointerenter")}
        onMouseOver={() => L("mouseover")} onMouseEnter={() => L("mouseenter")}
        onMouseMove={() => L("mousemove")}>zone</div>
      <button t="Open" type="button" onClick={() => dlg.current.showModal()}>open</button>
      <dialog id="modal" ref={dlg}
        {...({ onCancel: () => L("cancel"), onClose: () => L("close") } as any)}>
        <button t="Inside" type="button">x</button>
      </dialog>
    </main>
  );
}
`;

Deno.test({
  name: "e2e: am trigger in real chromium answers what real input answers",
  ignore: BROWSER === null,
  // The browser and the app are external processes, stopped in `finally`.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await tempDir("aio-ui-parity-");
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "UI Parity",
        appId: "ui-parity-e2e",
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
        },
        imports: {
          "aio": `${ROOT}mod.ts`,
          "aio/air": `${ROOT}src/air.ts`,
          "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.3",
        },
      }),
    );
    await Deno.writeTextFile(`${dir}/src/cells.ts`, CELLS);
    await Deno.writeTextFile(`${dir}/src/App.tsx`, APP_TSX);
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import "./cells.ts";\nimport { aio } from "aio";\nawait aio.run({ persist: false });\n`,
    );
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const app = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "src/app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: dir,
      env: { ...testDisplayEnv(), AIO_APPS_DIR: `${dir}/.aio-home` },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const profile = await tempDir("aio-ui-parity-chromium-");
    let browser: Deno.ChildProcess | null = null;
    let cdp: Awaited<ReturnType<typeof cdpConnect>> | null = null;
    try {
      await waitFor("parity server", async () => {
        const r = await fetch(`${base}/`);
        await r.body?.cancel();
        return r.ok ? true : null;
      }, 120_000);
      browser = new Deno.Command(BROWSER!, {
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--password-store=basic",
          "--use-mock-keychain",
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          `${base}/`,
        ],
        env: testDisplayEnv(),
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      const wsUrl = await waitFor("devtools", async () => {
        const p = Number(
          (await Deno.readTextFile(`${profile}/DevToolsActivePort`)).split(
            "\n",
          )[0],
        );
        const targets = await (await fetch(`http://127.0.0.1:${p}/json`))
          .json() as { type: string; webSocketDebuggerUrl: string }[];
        return targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
      });
      cdp = await cdpConnect(wsUrl);
      const js = async <T>(expression: string): Promise<T> => {
        const r = await cdp!.call("Runtime.evaluate", {
          expression,
          returnByValue: true,
        }) as { result?: { value?: T } };
        return r.result?.value as T;
      };
      const clientIdx = await waitFor("browser client", async () => {
        const cs = await (await fetch(`${base}/__aio/trojan/clients`))
          .json() as { index: number; type: string }[];
        return cs.filter((c) => c.type === "browser").map((c) => c.index)
          .sort((a, b) => b - a)[0];
      });
      await waitFor(
        "mounted",
        async () =>
          (await js<boolean>(`!!document.getElementById("modal")`)) || null,
      );
      const paths = new Map<string, string>();
      await waitFor("surface", async () => {
        type Node = {
          elements: { name: string; path: string }[];
          children: Node[];
        };
        const stack = await (await fetch(
          `${base}/__aio/trojan/surface/${clientIdx}`,
        )).json() as Node[];
        while (stack.length) {
          const n = stack.pop()!;
          for (const e of n.elements ?? []) paths.set(e.name, e.path);
          stack.push(...(n.children ?? []));
        }
        return paths.has("Inside") ? true : null;
      });
      const trigger = async (
        name: string,
        action: string,
        extra: Record<string, unknown> = {},
      ) => {
        const path = paths.get(name);
        assert(path, `${name} not on the surface: ${[...paths.keys()]}`);
        const r = await (await fetch(
          `${base}/__aio/trojan/trigger/${clientIdx}`,
          {
            method: "POST",
            headers: { "x-aio": "1", "content-type": "application/json" },
            body: JSON.stringify({ path, action, ...extra }),
          },
        )).json() as { ok: boolean; error?: string };
        return r;
      };
      const step = async (fn: () => Promise<unknown>) => {
        await js(`globalThis.__log.length = 0`);
        await fn();
        await sleep(150);
        return (await js<string[]>(`globalThis.__log`)).join("|");
      };
      const serverText = async () =>
        ((await (await fetch(`${base}/__aio/trojan/state`)).json()) as {
          probe?: { text?: string };
        }).probe?.text;

      // 1. keystroke echoes: one trigger, 95 chars, a macrotask apart.
      assert((await trigger("Cell", "type", { text: A95 })).ok);
      // The calls are acked one by one, so the server trails the typing by
      // seconds; a lost keystroke never arrives at all.
      await waitFor("server text", async () => {
        const t = await serverText();
        return t === A95 || (t && !A95.startsWith(t)) ? true : null;
      }, 30_000).catch(() => {});
      assertEquals(await serverText(), A95, "keystrokes lost on the server");
      assertEquals(
        await js<string>(`document.querySelector('[aria-label=cell]').value`),
        A95,
      );

      // 2. implicit submission (the real-input column).
      const press = (n: string, key: string) => () =>
        trigger(n, "press", { key });
      assertEquals(
        await step(press("B1In", "Enter")),
        "B1-click|B1-submit@b1",
      );
      assertEquals(await step(press("B2In", "Enter")), "");
      assertEquals(await step(press("CArea", "Enter")), 'C-input:"\\n"');
      assertEquals(await step(press("FIn", "Enter")), "");
      assertEquals(
        await step(async () => {
          await trigger("DIn", "type", { text: "x" });
          await trigger("DIn", "press", { key: "Enter" });
        }),
        "D-change:x|D-submit",
      );
      assertEquals(await step(press("DBtn", "Enter")), "D-click");
      assertEquals(
        await step(press("B1Btn", "Enter")),
        "B1-click|B1-submit@b1",
      );
      assertEquals(await step(press("DBtn", " ")), "D-click");

      // 3. click moves focus and commits the edited field.
      assertEquals(
        await step(async () => {
          await trigger("Commit", "type", { text: "z" });
          await trigger("Go", "click");
        }),
        "change:z|click active=cb",
      );

      // 4. event fields.
      assertEquals(
        await step(async () => {
          await trigger("Fid", "type", { text: "a" });
          await trigger("Fid", "press", { key: "Enter" });
        }),
        [
          "keydown KeyA 65",
          "keypress KeyA 97",
          "beforeinput insertText a",
          "input InputEvent insertText a",
          "keydown Enter 13",
          "keypress Enter 13",
          "beforeinput insertLineBreak",
        ].join("|"),
      );

      // 5. number / date.
      assert((await trigger("Num", "type", { text: "1a2" })).ok);
      assertEquals(
        await js<string>(`document.querySelector('[aria-label=num]').value`),
        "12",
      );
      const typedDate = await trigger("When", "type", {
        text: "2024-01-05",
      });
      assert(!typedDate.ok && /setValue/.test(typedDate.error ?? ""));
      assert((await trigger("When", "clear")).ok);
      assert(
        (await trigger("When", "type", { text: "2024-01-05" })).ok,
        "clear+type (am setValue) assigns a whole date",
      );
      assertEquals(
        await js<string>(`document.querySelector('[aria-label=when]').value`),
        "2024-01-05",
      );

      // 6. dblclick / hover.
      assertEquals(
        await step(() => trigger("Dbl", "dblclick")),
        "click|click|dbl2",
      );
      assertEquals(
        await step(() => trigger("Zone", "hover")),
        "pointerover|pointerenter|mouseover|mouseenter|mousemove",
      );

      // 7. Escape closes the modal.
      assert((await trigger("Open", "click")).ok);
      assertEquals(
        await js<boolean>(`document.getElementById("modal").open`),
        true,
      );
      assertEquals(
        await step(press("Inside", "Escape")),
        "cancel|close",
      );
      assertEquals(
        await js<boolean>(`document.getElementById("modal").open`),
        false,
      );
    } finally {
      await cdp?.close().catch(() => {});
      if (browser) await stopChild(browser, { quiet: true });
      await stopChild(app, { quiet: true });
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

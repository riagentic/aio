// JSX typing that COMPILED in 1.0.23-beta must still compile — the surface is
// frozen. Two additions broke an app that type-checked:
//   - the typed `<webview>` attributes (`allowpopups?: boolean`) refused an
//     app's own `webview` declaration with `allowpopups?: string` (TS2411:
//     the app's entry is checked against the unlisted-tag index type);
//   - `JSX.ElementType` as `(props: any) => JsxNode` refused a component with
//     a second required parameter (`(props, ref)`).
// Each is an app's own file, checked in its OWN program: an augmentation is
// global to a check graph, so it cannot share `deno task check`'s.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

const APP = `
declare module "aio/jsx-runtime" {
  interface JsxIntrinsicElements {
    webview: {
      src?: string;
      allowpopups?: string;
      partition?: string;
      webpreferences?: string;
      class?: string;
    };
  }
}
export const x = <webview src="https://x" allowpopups="true" />;

function Legacy(props: { n: number }, ref: { current: null }) {
  void ref;
  return <b>{props.n}</b>;
}
export const y = <Legacy n={1} />;
`;

Deno.test("jsx: an app's own webview declaration and a (props, ref) component still type-check", async () => {
  const dir = await tempDir("aio-jsx-augment-");
  try {
    const file = join(dir, "app.tsx");
    await Deno.writeTextFile(file, APP);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--config", CONFIG, file],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  } finally {
    await dropTempDir(dir);
  }
});

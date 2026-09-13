/**
 * @module
 * `am preview <file> [--export=Name] [--props=JSON]` — render ONE component,
 * with props you choose, and print what it produces.
 *
 * The gap it fills (report 3 §12.5): checking a component in a state the app
 * does not currently have meant driving the whole app into that state — a
 * dispatch, a fixture, sometimes a login — or writing a throwaway script with
 * happy-dom, a document and an import in it. Neither is a thing anyone does
 * while iterating on an empty state or an error card.
 *
 * It is the SAME renderer path `am surface` and `am testgen` use
 * (`renderHeadlessSurface`), pointed at one export with props attached. One
 * decider: a preview that rendered differently from the surface would be
 * answering a question about itself.
 */

import { toFileUrl } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { projectRoot } from "./am-cmd-process.ts";
import { resolveFileArg } from "./am-project.ts";
import { readDenoJsonSync } from "../server/deno-json.ts";
import { resolveAppDir } from "../build/build-config.ts";
import { resolveEntryPath } from "../server/paths.ts";
import { renderHeadlessSurface } from "../server/server-surface.ts";
import type { UISurfaceNode } from "../air/ui-surface.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { composeCells } from "../state/cell-compose.ts";
import { bindCell } from "../state/cell-catalog.ts";

/** Parse `--props=` into an object, or say exactly what is wrong with it.
 *
 *  Pure, and it REFUSES a non-object: `--props=42` parses as JSON and then
 *  spreads into nothing, so a component would render with no props and look
 *  like the bug the author is hunting. */
export function parsePreviewProps(
  raw: string | undefined,
): { ok: true; props: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, props: {} };
  if (!raw.trim()) {
    return {
      ok: false,
      error: "--props= is empty. Give it a JSON object, e.g. " +
        `--props='{"title":"Hello"}' — or omit the flag entirely.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: `--props is not valid JSON (${
        e instanceof Error ? e.message : e
      }). In a shell, single-quote it: --props='{"title":"Hello"}'`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `--props must be a JSON OBJECT, not ${
        Array.isArray(parsed) ? "an array" : typeof parsed
      }. A component receives one props object: --props='{"n":1}'`,
    };
  }
  return { ok: true, props: parsed as Record<string, unknown> };
}

/** Flatten a surface into lines: each component, then the elements it renders,
 *  addressed by the SAME `Component:Element` path `am trigger` takes.
 *
 *  Pure, so the formatting is testable without a render. */
export function previewLines(roots: readonly UISurfaceNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly UISurfaceNode[]) => {
    for (const n of nodes) {
      const label = n.handle ? `${n.component} (t=${n.handle})` : n.component;
      out.push(n.text ? `${label}  ${n.text}` : label);
      for (const el of n.elements ?? []) {
        // The addressable form, verbatim — a preview that printed a different
        // vocabulary from `am trigger` would be one more thing to translate.
        out.push(
          `  ${n.component}:${el.name}  <${el.tag}>` +
            (el.text ? `  ${el.text}` : "") +
            (el.value !== undefined
              ? `  value=${JSON.stringify(el.value)}`
              : ""),
        );
      }
      walk(n.children ?? []);
    }
  };
  walk(roots);
  return out;
}

/** Bind the cells `file` imports to their DECLARED state, read-only, so the
 *  component renders with selectors that work.
 *
 *  `am surface` renders inside the running server, where every cell is already
 *  bound to the app; `am preview` renders in this process, where nothing had
 *  bound them. A field read still worked (it falls back to the declared
 *  initial state) but a selector is only a function once bound, so
 *  `notes.open()` threw "notes.open is not a function" in a preview and
 *  rendered in the live surface.
 *
 *  Bound with the SAME two calls the server's boot makes (`composeCells`, then
 *  `bindCell`), over a state nothing can change — not by booting a runtime: a
 *  preview renders a component, not the app, and the harness runtimes are not
 *  the CLI's to boot (scripts/check-boundaries.ts). So a method called during
 *  the render still refuses loudly, as it did before it was bound. */
async function bindImportedCells(file: string): Promise<void> {
  // Importing the module registers the cells it reaches; a broken import is
  // left to the render, which reports it in its own words.
  try {
    await import(toFileUrl(file).href);
  } catch {
    return;
  }
  const cells = [...getRegisteredCells().values()].filter((c) =>
    !c.__aio.bound
  );
  if (cells.length === 0) return;
  const state = composeCells(cells, { appId: "am-preview" }).initialState;
  for (const c of cells) {
    bindCell(c, (action) => {
      throw new Error(
        `am preview renders a component with its cells' declared state, and ` +
          `runs no methods — ${action.type}() was called during the render. ` +
          `Drive a running app with am trigger, or test it with testUI.`,
      );
    }, () => state);
  }
}

/** `am preview <file> [--export=Name] [--props=JSON]` */
export async function cmdPreview(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    outError(
      "am preview needs a file: am preview src/Card.tsx " +
        `[--export=Card] [--props='{\"title\":\"Hi\"}']`,
      mode,
    );
    Deno.exit(1);
  }
  const root = projectRoot();
  // The SAME base-dir resolution `am testgen` and `am check` use — two
  // spellings of "where does this app live" is how they come to disagree.
  const baseDir = resolveAppDir(
    root,
    resolveEntryPath(readDenoJsonSync(root)?.config),
  );
  // The path a shell completes (cwd-relative) first; the app-directory
  // spelling (`ui/Card.tsx`) is still found after it — see resolveFileArg.
  const found = resolveFileArg(file, [root, baseDir]);
  if (!found.ok) {
    outError(
      `am preview: no such file ${file} — looked for ${found.tried.join(", ")}`,
      mode,
    );
    Deno.exit(1);
  }
  const path = found.path;

  const props = parsePreviewProps(
    args.find((a) => a.startsWith("--props="))?.slice(8),
  );
  if (!props.ok) {
    outError(`am preview: ${props.error}`, mode);
    Deno.exit(1);
  }
  const exportName = args.find((a) => a.startsWith("--export="))?.slice(9);

  await bindImportedCells(path);
  const rendered = await renderHeadlessSurface(path, true, {
    ...(exportName ? { exportName } : {}),
    props: props.props,
  });
  if (!rendered.ok) {
    outError(`am preview: ${rendered.error}`, mode);
    Deno.exit(1);
  }
  const roots = (rendered.roots ?? []) as UISurfaceNode[];
  const lines = previewLines(roots);
  out(
    mode === "pretty"
      ? (lines.length > 0
        ? lines.join("\n")
        // NOT an empty success. A component that rendered nothing and a
        // component that rendered something unaddressable look identical on
        // an empty screen, and only one of them is what the author meant.
        : `(rendered nothing addressable — the component produced no named ` +
          `elements. Name them with the \`t\` prop, e.g. <button t="save">, ` +
          `or check that these props put it in the state you expected.)`)
      : {
        file: path,
        export: exportName ?? "default",
        props: props.props,
        roots,
      },
    mode,
  );
}

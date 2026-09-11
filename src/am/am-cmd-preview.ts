/**
 * @module
 * `am preview <file> [--export=Name] [--props=JSON]` — render ONE component,
 * with props you choose, and print what it produces.
 *
 * The gap it fills (vidtune §12.5): checking a component in a state the app
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

import { resolve } from "@std/path";
import { isAbsolute } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { projectRoot } from "./am-cmd-process.ts";
import { readDenoJsonSync } from "../server/deno-json.ts";
import { resolveAppDir } from "../build/build-config.ts";
import { resolveEntryPath } from "../server/paths.ts";
import { renderHeadlessSurface } from "../server/server-surface.ts";
import type { UISurfaceNode } from "../air/ui-surface.ts";

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
  const path = isAbsolute(file) ? file : resolve(baseDir, file);
  try {
    Deno.statSync(path);
  } catch {
    outError(
      `am preview: no such file ${path} — paths are relative to the app ` +
        `directory (${baseDir}), not the shell's cwd.`,
      mode,
    );
    Deno.exit(1);
  }

  const props = parsePreviewProps(
    args.find((a) => a.startsWith("--props="))?.slice(8),
  );
  if (!props.ok) {
    outError(`am preview: ${props.error}`, mode);
    Deno.exit(1);
  }
  const exportName = args.find((a) => a.startsWith("--export="))?.slice(9);

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

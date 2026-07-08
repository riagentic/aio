// cell-compose-resolve.ts — dependency resolution, cycle detection, topological sort

import type { CellDef, CellEntry } from "./cell-types.ts";

/** Resolve cell entries, validate dependencies, return topologically sorted list */
export function resolveCells(entries: CellEntry[]): CellDef[] {
  const cells: CellDef[] = [];
  const deps = new Map<string, string[]>();

  const seen = new Set<string>();
  for (const entry of entries) {
    const f = "__aio" in entry
      ? entry as CellDef
      : (entry as { cell: CellDef }).cell;
    if (seen.has(f.__aio.id)) {
      throw new Error(
        `duplicate cell name: '${f.__aio.id}' — two cells passed to aio.run({ cells }) share this name. Rename one (e.g. '${f.__aio.id}2') or remove the duplicate entry.`,
      );
    }
    seen.add(f.__aio.id);
    cells.push(f);
    if ("__aio" in entry) {
      deps.set(f.__aio.id, []);
    } else {
      deps.set(
        f.__aio.id,
        (entry as { dependsOn?: string[] }).dependsOn ?? [],
      );
    }
  }

  // Validate dependencies exist
  const names = new Set(cells.map((f) => f.__aio.id));
  for (const [name, depList] of deps) {
    for (const dep of depList) {
      if (!names.has(dep)) {
        throw new Error(
          `[cell:${name}] depends on unknown cell '${dep}'. Known cells: ${
            [...names].join(", ") || "(none)"
          }. Add it to aio.run({ cells }) or fix the name in deps.`,
        );
      }
    }
  }

  // Cycle detection (DFS)
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function visit(name: string, path: string[]): void {
    if (inStack.has(name)) {
      throw new Error(`dependency cycle: ${[...path, name].join(" → ")}`);
    }
    if (visited.has(name)) return;
    inStack.add(name);
    for (const dep of deps.get(name) ?? []) {
      visit(dep, [...path, name]);
    }
    inStack.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name, []);

  // Topological sort
  const sorted: CellDef[] = [];
  const placed = new Set<string>();
  function place(name: string): void {
    if (placed.has(name)) return;
    for (const dep of deps.get(name) ?? []) place(dep);
    placed.add(name);
    sorted.push(cells.find((f) => f.__aio.id === name)!);
  }
  for (const f of cells) place(f.__aio.id);

  return sorted;
}

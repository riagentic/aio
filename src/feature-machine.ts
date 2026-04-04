// feature-machine.ts — machine validation

import type { MachineConfig } from "./feature-types.ts";
import { log } from "./logger.ts";

/** Validate a state machine config — checks initial state, transitions, reachability, and dead-ends. */
export function validateMachine(
  name: string,
  machine: MachineConfig,
  actionKeys: Set<string>,
): void {
  const errors: string[] = [];
  const stateNames = new Set(Object.keys(machine.states));

  // Initial state must exist
  if (!stateNames.has(machine.initial)) {
    errors.push(`machine.initial '${machine.initial}' not in declared states`);
  }

  // Validate transitions + dead-end detection in one pass
  const warnings: string[] = [];
  for (const [stateName, stateConfig] of Object.entries(machine.states)) {
    const transitions = stateConfig;
    if (Object.keys(transitions).length === 0) {
      warnings.push(
        `state '${stateName}' is a dead-end (no outgoing transitions)`,
      );
    }
    for (const [key, target] of Object.entries(transitions)) {
      if (!stateNames.has(target)) {
        errors.push(
          `state '${stateName}' → unknown target '${target}' on '${key}'`,
        );
      }
      if (!key.includes(":") && !actionKeys.has(key)) {
        errors.push(`state '${stateName}' references unknown action '${key}'`);
      }
    }
  }

  // Reachability: BFS from initial, then flag unreachable states
  const reachable = new Set<string>([machine.initial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [sn, sc] of Object.entries(machine.states)) {
      if (!reachable.has(sn)) continue;
      for (const t of Object.values(sc)) {
        if (!reachable.has(t)) {
          reachable.add(t);
          changed = true;
        }
      }
    }
  }
  for (const sn of stateNames) {
    if (!reachable.has(sn)) {
      errors.push(`state '${sn}' unreachable from '${machine.initial}'`);
    }
  }

  if (errors.length) {
    throw new Error(
      `[feature:${name}] machine validation failed:\n  ${errors.join("\n  ")}`,
    );
  }
  if (warnings.length) {
    for (const w of warnings) log.warn("feature", `${name} ${w}`);
  }
}

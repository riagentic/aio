// self.ts — self-referencing action descriptors (alpha52, the effect channel).
//
// A method that schedules ITS OWN cell used to need `: CellEffect` return
// annotations (TS7022: the cell's type is being inferred while the method body
// references it). `self("tick")` builds the action descriptor without touching
// the cell object at all, so the self-reference — and the annotation — go away:
//
//   methods: {
//     tick(s) { s.n++; s.$do(schedule.after("next", 1000, self("tick"))); },
//   }
//
// The descriptor is resolved BY THE DISPATCHING CELL: when the effect that
// carries it is captured (sync classify / async $do / the deprecated return
// path), `__aioSelf:tick` becomes `<cell>:tick`. An unknown method name throws
// at cell() time when the descriptor is statically present (cancelOn), and at
// dispatch time otherwise — loud both ways. A descriptor that escapes without
// resolution (e.g. handed to `aio.run({ schedules })`, where there is no owning
// cell) is refused by the schedule manager's id/action validation with the same
// message, never silently dispatched as a type no cell answers.

/** Marker prefix — `self("tick")` produces `{ type: "__aioSelf:tick" }` until
 *  the owning cell resolves it to `<cell>:tick`. Internal (`__` prefix), so the
 *  network can never inject it. @internal */
export const SELF_PREFIX = "__aioSelf:";

/** A self-referencing action descriptor, pre-resolution. Structurally a normal
 *  `{ type, payload }` action so it slots into `schedule.*` unchanged. */
export type SelfAction = {
  type: `${typeof SELF_PREFIX}${string}`;
  payload: { args: unknown[] };
};

/** Build an action descriptor for a method of THE CELL THAT DISPATCHES IT —
 *  no cell reference needed, so self-scheduling methods stop tripping
 *  TypeScript's self-referential-inference guard (TS7022/7023).
 *
 *  Resolved by the dispatching cell: pass it wherever an action descriptor
 *  goes inside that cell — `schedule.*` via `s.$do`, `cancelOn` lists. An
 *  unknown method name throws at `cell()` time when statically present
 *  (cancelOn), else at dispatch.
 *
 *  ```ts
 *  s.$do(schedule.after("next", 1000, self("tick")));
 *  cancelOn: { search: [self("clear")] }
 *  ``` */
export function self(method: string, ...args: unknown[]): SelfAction {
  if (!method || typeof method !== "string") {
    throw new Error(
      `self(): method name must be a non-empty string, got ${
        JSON.stringify(method)
      }`,
    );
  }
  return { type: `${SELF_PREFIX}${method}`, payload: { args } };
}

/** The method name a self-descriptor names, or null for a normal action.
 *  Accepts anything (effect payloads are untrusted shapes). @internal */
export function selfMethodOf(action: unknown): string | null {
  const t = (action as { type?: unknown } | null)?.type;
  if (typeof t !== "string" || !t.startsWith(SELF_PREFIX)) return null;
  return t.slice(SELF_PREFIX.length);
}

/** Resolve a self-descriptor against its owning cell — the ONE decider for
 *  what `self("m")` means. Throws (loud, at the capture site) when the cell
 *  has no such method; returns the input unchanged for normal actions.
 *  @internal */
export function resolveSelfAction<
  A extends { type: string; payload?: unknown },
>(
  action: A,
  cellName: string,
  hasMethod: (method: string) => boolean,
  knownMethods: () => string[],
): A {
  const m = selfMethodOf(action);
  if (m === null) return action;
  if (!hasMethod(m)) {
    throw new Error(
      `[${cellName}] self("${m}") — no method named '${m}' on this cell. ` +
        `Known methods: ${knownMethods().join(", ") || "(none)"}.`,
    );
  }
  return {
    ...action,
    type: `${cellName}:${m}`,
  } as A;
}

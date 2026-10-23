// `describe` — what a connected caller may call on this app, asked over the
// caller's own connection. It rides the action door (`dispatchNetwork`), so it
// passes the same auth, the same per-connection user and the same `access`
// rules as a real call: it lists exactly the methods that caller could call,
// and nothing it could not. No state, no hidden fields, no source.
import type { AioUser } from "./aio.ts";
import type { Access } from "../state/cell-types.ts";
import { cellAccessAllowed } from "./server-auth.ts";

/** The action type of a describe request. `$` cannot start a cell name, so it
 *  can never collide with an app's own `cell:method`. */
export const DESCRIBE_TYPE = "$aio:describe";

/** One method a caller may call. `args`: required argument count (absent for
 *  an actions-form cell); `async`: it runs to completion before answering.
 *  @experimental */
export type PeerMethod = { args?: number; async: boolean };

/** What `peer().describe()` answers.
 *  @experimental */
export type PeerDescription = {
  app: string;
  version: string;
  aio: string;
  cells: Record<string, { methods: Record<string, PeerMethod> }>;
  /** The app's published types (`aio.run({ peerTypes })`), when it has any. */
  types?: string;
};

export type DescribeSource = {
  appId: string;
  appVersion: string;
  aio: string;
  methods: Record<string, string[]>;
  async: Record<string, string[]>;
  arity: Record<string, Record<string, number>>;
  access?: Map<string, Access>;
  types?: string;
};

/** The calls `user` may make. A method guarded by a rule that needs the call's
 *  arguments to decide is left out — `describe` never claims a call it cannot
 *  vouch for. A cell with nothing callable is left out whole. */
export function describeFor(
  src: DescribeSource,
  user: AioUser | undefined,
): PeerDescription {
  const cells: PeerDescription["cells"] = {};
  for (const [cell, names] of Object.entries(src.methods)) {
    const rule = src.access?.get(cell);
    const methods: Record<string, PeerMethod> = {};
    for (const m of names) {
      if (rule !== undefined && !cellAccessAllowed(rule, user, m, [], true)) {
        continue;
      }
      const args = src.arity[cell]?.[m];
      methods[m] = {
        ...(args !== undefined ? { args } : {}),
        async: src.async[cell]?.includes(m) ?? false,
      };
    }
    if (Object.keys(methods).length > 0) cells[cell] = { methods };
  }
  return {
    app: src.appId,
    version: src.appVersion,
    aio: src.aio,
    cells,
    ...(src.types !== undefined ? { types: src.types } : {}),
  };
}

/** `aio.run({ peerTypes })` must be the types' SOURCE TEXT — a value a caller
 *  can save as a `.ts` file. Anything else throws at boot, naming the fix. */
export function checkPeerTypes(v: unknown): string {
  if (typeof v === "string") return v;
  throw new TypeError(
    `aio.run({ peerTypes }): expected the types as source text, got ` +
      `${v === null ? "null" : typeof v} — import the file as text: ` +
      `import types from "./contract.ts" with { type: "text" }`,
  );
}

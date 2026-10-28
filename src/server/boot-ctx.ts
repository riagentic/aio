// The locals of `_runPhases` (aio.ts) that its moved-out steps use. Each is a
// getter (and, for a `let` a step assigns, a setter) over the boot's own
// variable, so a step reads and writes it live, as the closure it was did.
// `readonly` = no moved step assigns it.
//
// aio.ts keeps every import it had, in its place — a bare `import "x"; // load
// order` where only a moved step uses the names — so modules still evaluate in
// the order they did before the steps moved out.
import type { CliFlags } from "./aio-cli.ts";
import type { AioConfig } from "./aio-types.ts";
import type { AppDirs } from "./app-dirs.ts";

/** The boot's locals, live. */
export interface BootCtx<S, A, E> {
  readonly config: AioConfig<S, A, E>;
  readonly cli: CliFlags;
  readonly appId: string;
  _heapLine: string | undefined;
  _stampDataDir: (() => Promise<void>) | undefined;
  readonly _dirs: AppDirs;
  distDir: string;
  prod: boolean;
}

/** The context over the boot's own variables: each field is a getter that
 *  reads its variable when read; a `[get, set]` pair also assigns it. */
export function liveCtx<T extends object>(
  fields: { [K in keyof T]: (() => T[K]) | [() => T[K], (v: T[K]) => void] },
): T {
  const ctx = {} as T;
  for (
    const [k, f] of Object.entries(fields) as [
      string,
      (() => unknown) | [() => unknown, (v: unknown) => void],
    ][]
  ) {
    const [get, set] = typeof f === "function" ? [f, undefined] : f;
    Object.defineProperty(ctx, k, { get, set, enumerable: true });
  }
  return ctx;
}

/** A moved step's parameters after the context. */
export type StepArgs<F> = F extends (c: never, ...a: infer R) => unknown ? R
  : never;

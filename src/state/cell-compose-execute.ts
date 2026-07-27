// cell-compose-execute.ts — root executor: routes effects to the owning
// cell's executor (async-method triggers, schedule/own bridges). Generator
// flow dispatch died with Style B (perfect-aio D1).

import { log } from "../diagnostics/logger.ts";
import type { AioError } from "../diagnostics/error.ts";
import { createAioError } from "../diagnostics/error.ts";
import type { CellDef, Msg, ScopedApp } from "./cell-types.ts";
import { tagSource } from "./cell-types.ts";
import type { ReduceContext } from "./cell-compose-reduce.ts";

/** Build the root execute function for dispatching effects to cell executors. */
export function buildRootExecutor(
  cells: CellDef[],
  ctx: ReduceContext,
  reportError: ((err: AioError) => void) | undefined,
  countCellError: (name: string) => void,
): (
  app: { dispatch: (a: Msg) => unknown; getState: () => unknown },
  effect: Msg,
) => void {
  const executorByPrefix = new Map<string, CellDef>();
  for (const f of cells) {
    if (f.__aio.execute) executorByPrefix.set(f.__aio.id, f);
  }

  return (
    app: { dispatch: (a: Msg) => unknown; getState: () => unknown },
    effect: Msg,
  ): void => {
    const colonIdx = (effect.type as string).indexOf(":");
    if (colonIdx === -1) return;

    const prefix = (effect.type as string).slice(0, colonIdx);

    const f = executorByPrefix.get(prefix);
    if (!f || !f.__aio.execute) return;
    if (ctx.disabledCells.has(f.__aio.id)) return;

    const cellName = f.__aio.id;
    const scopedApp: ScopedApp & {
      _isDisabled?: () => boolean;
      _onError?: (err: AioError) => void;
    } = {
      _isDisabled: () => ctx.disabledCells.has(cellName),
      _onError: reportError,
      dispatch: (a: Msg) => {
        if (typeof a?.type !== "string") return;
        // Hand the store's promise back: an async method's batcher awaits it to
        // learn whether its write-set was accepted. Swallowing it here is what
        // let a refused write resolve as success.
        return app.dispatch(tagSource(a, "Effect"));
      },
      getState: () =>
        (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
      getFullState: () => app.getState() as Record<string, unknown>,
    };

    try {
      f.__aio.execute(scopedApp, effect);
    } catch (e) {
      if (reportError) {
        reportError(
          createAioError("EFFECT_ERROR", e, {
            cellName: f.__aio.id,
            effectType: (effect as { type: string }).type,
          }),
        );
      } else {
        log.error("cell", `${f.__aio.id} executor threw: ${e}`);
      }
      countCellError(f.__aio.id);
    }
  };
}

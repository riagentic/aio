// cell-compose-execute.ts — root executor: routes effects to the owning
// cell's executor (async-method triggers, schedule/own bridges). Generator
// flow dispatch died with Style B (perfect-aio D1).

import { log } from "../diagnostics/logger-api.ts";
import type { AioError } from "../diagnostics/error.ts";
import { createAioError } from "../diagnostics/error.ts";
import type { CellDef, Msg, ScopedApp } from "./cell-types.ts";
import { tagSource } from "./cell-types.ts";
import type { ReduceContext } from "./cell-compose-reduce.ts";
import { routeEffect } from "./route-effect.ts";

/** A framework effect reached the ROOT executor, which is not the thing that
 *  runs it.
 *
 *  Every real runtime classifies with `routeEffect` FIRST (server
 *  aio-dispatch, standalone-air, the worker host) and hands `__schedule` /
 *  `__own` to the component that owns the clock and the resource table — so
 *  this executor only ever sees app effects there. The one caller that does
 *  not is `testCell`, which drives `composed.execute` directly and owns
 *  neither: it dropped both kinds on the floor because their type carries no
 *  `cell:` prefix. `s.$do(schedule.after(…))` therefore never fired and
 *  `own()` never disposed — in the harness only, silently, with the test
 *  green.
 *
 *  Silence is the defect, so this throws and names the harness that does run
 *  them. */
function frameworkEffectInWrongRuntime(kind: "schedule" | "own"): Error {
  const what = kind === "schedule"
    ? "a schedule effect (schedule.after / every / at / cron)"
    : "an own() effect (acquire / dispose of a resource)";
  const runs = kind === "schedule"
    ? "a clock to fire it on"
    : "a resource table to hold it in";
  return new Error(
    `[aio] ${what} reached the root cell executor, which has ${
      kind === "schedule" ? "no clock" : "no resource table"
    }.\n` +
      `  cause: this effect only runs in a runtime that owns ${runs} — the ` +
      `server loop, the standalone/Android loop, or the worker host. ` +
      `\`testCell\` runs the composed executor directly and owns neither, so ` +
      `the effect would be silently dropped.\n` +
      `  fix: test this cell with \`bootCells([cell])\` (or \`testUI\`), which ` +
      `boots the standalone runtime — \`await h.advance(ms)\` fires due ` +
      `schedules and \`h.dispose()\` disposes owned resources. Keep ` +
      `\`testCell\` for the reduce/method logic that emits the effect.`,
  );
}

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
    // Framework effects are NOT this executor's to run — and dropping them was
    // silent (see frameworkEffectInWrongRuntime). Classified with the one
    // shared router so a new framework kind cannot slip through as an app
    // effect here either.
    let frameworkKind: "schedule" | "own" | null = null;
    routeEffect<Msg>(effect, {
      schedule: () => {
        frameworkKind = "schedule";
      },
      own: () => {
        frameworkKind = "own";
      },
      app: () => {},
    });
    if (frameworkKind !== null) {
      throw frameworkEffectInWrongRuntime(frameworkKind);
    }

    const colonIdx = (effect.type as string).indexOf(":");
    // A bare, un-prefixed app effect names no cell to execute it. Not thrown —
    // `listensTo` on a bare action type is a shape the framework still accepts
    // (aio-composition refuses the ESCALATING case at boot), and the reducers
    // have already seen it; there is simply no executor to route it to.
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

// cell-compose-execute.ts — root executor: flow dispatch and effect routing

import { log } from "./logger.ts";
import type { FlowDef } from "./flow.ts";
import { runFlow } from "./flow.ts";
import type { AioError } from "./error.ts";
import { createAioError } from "./error.ts";
import type { CellDef, Msg, ScopedApp } from "./cell-types.ts";
import { tagSource } from "./cell-types.ts";
import type { ReduceContext } from "./cell-compose-reduce.ts";

type FlowsByPrefix = Map<
  string,
  {
    cellName: string;
    flows: Record<string, FlowDef>;
    triggers: Map<string, string>;
  }
>;

/** Build the root execute function for dispatching effects and triggering flows */
export function buildRootExecutor(
  cells: CellDef[],
  flowsByPrefix: FlowsByPrefix,
  ctx: ReduceContext,
  reportError: ((err: AioError) => void) | undefined,
  countCellError: (name: string) => void,
): (
  app: { dispatch: (a: Msg) => void; getState: () => unknown },
  effect: Msg,
) => void {
  const executorByPrefix = new Map<string, CellDef>();
  for (const f of cells) {
    if (f.__aio.execute) executorByPrefix.set(f.__aio.id, f);
  }

  return (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
    effect: Msg,
  ): void => {
    const colonIdx = (effect.type as string).indexOf(":");
    if (colonIdx === -1) return;

    const prefix = (effect.type as string).slice(0, colonIdx);

    // Handle __flow effects — start a generator flow
    if ((effect.type as string).endsWith(":__flow")) {
      const flowInfo = flowsByPrefix.get(prefix);
      if (!flowInfo) return;
      const payload = effect.payload as {
        _flowName: string;
        _triggerAction: Msg;
      };
      const flowDef = flowInfo.flows[payload._flowName];
      if (!flowDef) return;

      const flowApp = {
        dispatch: (a: Msg) => app.dispatch(a),
        getState: () => app.getState() as Record<string, unknown>,
      };

      runFlow(
        flowDef,
        payload._flowName,
        flowInfo.cellName,
        payload._triggerAction,
        flowApp,
        reportError
          ? (raw, flowCtx) => {
            reportError(createAioError("FLOW_UNCAUGHT", raw, flowCtx));
          }
          : undefined,
      )
        .catch((e) => {
          if (reportError) {
            reportError(
              createAioError("FLOW_UNCAUGHT", e, {
                cellName: flowInfo.cellName,
                flowName: payload._flowName,
              }),
            );
          } else {
            log.error(
              "cell",
              `${flowInfo.cellName} flow '${payload._flowName}' error: ${e}`,
            );
          }
        });
      return;
    }

    // Skip internal flow state actions — handled by reducer
    if ((effect.type as string).endsWith(":__FlowState")) return;

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
        app.dispatch(tagSource(a, "Effect"));
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

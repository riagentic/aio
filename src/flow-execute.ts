// flow-execute.ts — executeStep: dispatch/mutate/wait logic for each FlowStep kind

import { produce } from "immer";
import { callWithOpts } from "./cell-impl.ts";
import type { Msg } from "./cell-types.ts";
import { log } from "./logger.ts";
import type {
  ActionListener,
  FlowApp,
  FlowInstance,
  FlowStep,
  StateListener,
} from "./flow-types.ts";
import { FlowFailError } from "./flow-types.ts";
import { _actionListeners, _stateListeners } from "./flow-listeners.ts";

/** Execute a single flow step — returns the value to feed back into the generator */
export async function executeStep(
  step: FlowStep,
  instance: FlowInstance,
  app: FlowApp,
  waitForListeners?: Set<ActionListener>,
  abortSignal?: AbortSignal, // AIO-262: for race abort propagation
): Promise<unknown> {
  // AIO-255: bail immediately if flow was aborted (prevents all/race continuations)
  // AIO-262: also bail if race was aborted (loser cleanup)
  if (instance.aborted || abortSignal?.aborted) return undefined;

  const { prefix, cellName } = instance;
  const flowPrefix = `${prefix}:__flow:`;

  switch (step.kind) {
    case "call": {
      if (instance.aborted || abortSignal?.aborted) return undefined;
      app.dispatch({
        type: `${flowPrefix}${step.name}`,
        payload: { _flow: instance.flowName, _step: step.name },
        _source: "Effect",
      });
      const result = step.opts
        ? await callWithOpts(step.fn, step.opts)
        : await step.fn();
      if (instance.aborted || abortSignal?.aborted) return undefined;
      return result;
    }

    case "step": {
      if (instance.aborted || abortSignal?.aborted) return undefined;
      app.dispatch({
        type: `${flowPrefix}${step.name}`,
        payload: { _flow: instance.flowName, _step: step.name },
        _source: "Effect",
      });
      const fullState = app.getState();
      const cellState = fullState[cellName] as Record<string, unknown>;
      const nextSlice = produce(cellState, (draft) => {
        step.mutate(draft as Record<string, unknown>);
      });
      app.dispatch({
        type: `${prefix}:__FlowState`,
        payload: { _slice: nextSlice },
        _source: "Effect",
      });
      return undefined;
    }

    case "done": {
      if (instance.aborted || abortSignal?.aborted) return undefined;
      if (step.mutate) {
        const fullState = app.getState();
        const cellState = fullState[cellName] as Record<string, unknown>;
        const nextSlice = produce(cellState, (draft) => {
          step.mutate!(draft as Record<string, unknown>);
        });
        app.dispatch({
          type: `${prefix}:__FlowState`,
          payload: { _slice: nextSlice },
          _source: "Effect",
        });
      }
      app.dispatch({
        type: `${flowPrefix}done`,
        payload: { _flow: instance.flowName },
        _source: "Effect",
      });
      return undefined;
    }

    case "fail": {
      if (instance.aborted || abortSignal?.aborted) return undefined;
      app.dispatch({
        type: `${flowPrefix}failed`,
        payload: { _flow: instance.flowName, reason: step.reason },
        _source: "Effect",
      });
      // AIO-253: throw sentinel so generator try/finally blocks execute properly
      throw new FlowFailError(step.reason);
    }

    case "dispatch": {
      if (instance.aborted || abortSignal?.aborted) return undefined;
      app.dispatch({ _source: "Effect", payload: {}, ...step.action });
      return undefined;
    }

    case "all": {
      const promises = step.entries.map((entry) =>
        executeStep(entry, instance, app, waitForListeners)
      );
      return Promise.all(promises);
    }

    case "race": {
      // AIO-262: abort losers when winner resolves to prevent listener leaks
      const raceController = new AbortController();
      const entries = Object.entries(step.entries);
      const result = await Promise.race(
        entries.map(async ([key, entry]) => {
          const value = await executeStep(
            entry,
            instance,
            app,
            waitForListeners,
            raceController.signal,
          );
          return { key, value };
        }),
      );
      raceController.abort();
      return { [result.key]: result.value };
    }

    case "sleep": {
      if (instance.aborted || abortSignal?.aborted) return undefined;
      app.dispatch({
        type: `${flowPrefix}${step.name}`,
        payload: { _flow: instance.flowName, _step: step.name, ms: step.ms },
        _source: "Effect",
      });
      const controller = new AbortController();
      instance.abortController = controller;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, step.ms);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      instance.abortController = undefined;
      if (instance.aborted || abortSignal?.aborted) return undefined;
      return undefined;
    }

    case "waitFor": {
      app.dispatch({
        type: `${flowPrefix}waitFor`,
        payload: {
          _flow: instance.flowName,
          actionType: step.actionType,
          timeout: step.timeout,
        },
        _source: "Effect",
      });

      // AbortController per-step — cancellation is instant via signal, no polling loop.
      const controller = new AbortController();
      instance.abortController = controller;

      // Hoist listener ref so timeout can delete the exact instance (not first match)
      let listener: ActionListener;
      const actionPromise = new Promise<Msg>((resolve) => {
        listener = { actionType: step.actionType, resolve };
        _actionListeners.add(listener);
        waitForListeners?.add(listener);

        // Resolve immediately on flow cancellation — no 50ms poll needed
        controller.signal.addEventListener("abort", () => {
          _actionListeners.delete(listener);
          waitForListeners?.delete(listener);
          resolve({ type: "__aborted", payload: {} });
        }, { once: true });
      });

      if (step.timeout !== undefined) {
        const timeoutSentinel = Symbol("timeout");
        const result = await Promise.race([
          actionPromise,
          new Promise<typeof timeoutSentinel>((resolve) =>
            setTimeout(() => resolve(timeoutSentinel), step.timeout)
          ),
        ]);
        instance.abortController = undefined;
        if (result === timeoutSentinel) {
          _actionListeners.delete(listener!); // delete exact instance, not first match
          waitForListeners?.delete(listener!);
          throw new Error(
            `waitFor('${step.actionType}') timed out after ${step.timeout}ms`,
          );
        }
        waitForListeners?.delete(listener!);
        return result;
      }

      // Dev mode: warn if waitFor has no timeout and has been waiting 30s
      let warnTimer: ReturnType<typeof setTimeout> | undefined;
      if ((globalThis as Record<string, unknown>).__aioDev) {
        warnTimer = setTimeout(() => {
          log.warn(
            "aio",
            `${instance.cellName} waitFor('${step.actionType}') has been waiting 30s with no timeout — did you mean to add one?`,
          );
        }, 30_000);
      }

      const result = await actionPromise;
      if (warnTimer) clearTimeout(warnTimer);
      instance.abortController = undefined;
      waitForListeners?.delete(listener!);
      return result;
    }

    case "when": {
      // Check immediately — if already true, no suspension needed
      const currentState = app.getState();
      try {
        if (step.predicate(currentState)) return undefined;
      } catch (e) {
        log.debug("aio", `when() predicate threw: ${e}`);
        // Fall through to register listener — treat throw as false
      }

      app.dispatch({
        type: `${flowPrefix}when`,
        payload: { _flow: instance.flowName, timeout: step.timeout },
        _source: "Effect",
      });

      // AbortController for instant cancellation (same pattern as waitFor)
      const controller = new AbortController();
      instance.abortController = controller;

      let whenListener: StateListener;
      const statePromise = new Promise<void>((resolve) => {
        whenListener = { predicate: step.predicate, resolve };
        _stateListeners.add(whenListener);
        instance.stateListeners.add(whenListener); // AIO-263: track in instance set for parallel when()

        controller.signal.addEventListener("abort", () => {
          _stateListeners.delete(whenListener);
          instance.stateListeners.delete(whenListener);
          resolve(); // resolve with undefined on abort — abortInstance sets instance.aborted
        }, { once: true });
      });

      if (step.timeout !== undefined) {
        const timeoutSentinel = Symbol("timeout");
        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          statePromise.then(() => undefined as undefined),
          new Promise<typeof timeoutSentinel>((resolve) => {
            timeoutId = setTimeout(
              () => resolve(timeoutSentinel),
              step.timeout,
            );
          }),
        ]);
        clearTimeout(timeoutId!); // clear timer whether state won or timeout won
        instance.abortController = undefined;
        instance.stateListeners.delete(whenListener!); // AIO-207: always clean up listener
        _stateListeners.delete(whenListener!);
        if (result === timeoutSentinel) {
          throw new Error(`when() timed out after ${step.timeout}ms`);
        }
        return undefined;
      }

      // Dev mode: warn if when() has no timeout and has been waiting 30s
      let warnTimer: ReturnType<typeof setTimeout> | undefined;
      if ((globalThis as Record<string, unknown>).__aioDev) {
        warnTimer = setTimeout(() => {
          log.warn(
            "aio",
            `${instance.cellName} when() has been waiting 30s with no timeout — did you mean to add one?`,
          );
        }, 30_000);
      }

      await statePromise;
      if (warnTimer) clearTimeout(warnTimer);
      instance.abortController = undefined;
      instance.stateListeners.delete(whenListener!);
      return undefined;
    }
  }
}

// Memoized selectors — cache derived state until inputs change
// Similar to reselect, but simpler and optimized for aio's use case

type Selector<S, R> = (state: S) => R

/**
 * Creates a memoized selector that caches results until inputs change.
 * Useful for expensive computations derived from state.
 * 
 * @param inputSelectors - One or more selectors that extract values from state
 * @param resultFunc - Computes result from input values
 * @returns Memoized selector function
 * 
 * @example
 * ```ts
 * const selectVisibleTodos = createSelector(
 *   (s: AppState) => s.todos,
 *   (s: AppState) => s.filter,
 *   (todos, filter) => todos.filter(t => t.status === filter)
 * )
 * 
 * // In getUIState:
 * getUIState: (state) => ({
 *   visibleTodos: selectVisibleTodos(state),
 *   user: state.user
 * })
 * ```
 */
export function createSelector<S, R1, Result>(
  selector1: Selector<S, R1>,
  resultFunc: (r1: R1) => Result,
): Selector<S, Result>
export function createSelector<S, R1, R2, Result>(
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  resultFunc: (r1: R1, r2: R2) => Result,
): Selector<S, Result>
export function createSelector<S, R1, R2, R3, Result>(
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  selector3: Selector<S, R3>,
  resultFunc: (r1: R1, r2: R2, r3: R3) => Result,
): Selector<S, Result>
export function createSelector<S, R1, R2, R3, R4, Result>(
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  selector3: Selector<S, R3>,
  selector4: Selector<S, R4>,
  resultFunc: (r1: R1, r2: R2, r3: R3, r4: R4) => Result,
): Selector<S, Result>
export function createSelector<S, R1, R2, R3, R4, R5, Result>(
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  selector3: Selector<S, R3>,
  selector4: Selector<S, R4>,
  selector5: Selector<S, R5>,
  resultFunc: (r1: R1, r2: R2, r3: R3, r4: R4, r5: R5) => Result,
): Selector<S, Result>
export function createSelector<S, R1, R2, R3, R4, R5, R6, Result>(
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  selector3: Selector<S, R3>,
  selector4: Selector<S, R4>,
  selector5: Selector<S, R5>,
  selector6: Selector<S, R6>,
  resultFunc: (r1: R1, r2: R2, r3: R3, r4: R4, r5: R5, r6: R6) => Result,
): Selector<S, Result>
export function createSelector<S, Result>(
  ...args: [...Selector<S, unknown>[], (...inputs: unknown[]) => Result]
): Selector<S, Result> {
  const selectors = args.slice(0, -1) as Selector<S, unknown>[]
  const combiner = args[args.length - 1] as (...inputs: unknown[]) => Result
  
  let lastInputs: unknown[] | null = null  // null on first call → always recomputes
  let lastResult: Result | undefined

  return (state: S): Result => {
    const inputs = selectors.map(fn => fn(state))

    if (lastInputs && inputs.length === lastInputs.length) {
      let changed = false
      for (let i = 0; i < inputs.length; i++) {
        if (inputs[i] !== lastInputs[i]) {
          changed = true
          break
        }
      }
      if (!changed) {
        return lastResult!
      }
    }
    
    lastInputs = inputs
    lastResult = (combiner as (...args: unknown[]) => Result)(...inputs)
    return lastResult
  }
}

/**
 * Creates a selector factory for a specific state slice.
 * Useful when the same derivation logic applies to different data.
 * 
 * @param selector - Base selector for extracting the slice
 * @returns Object with methods to create derived selectors
 * 
 * @example
 * ```ts
 * const selectTodosSlice = createSliceSelector((s: AppState) => s.todos)
 * 
 * const selectActiveTodos = selectTodosSlice.derive(todos => todos.filter(t => t.active))
 * ```
 */
export function createSliceSelector<S, T>(selector: Selector<S, T>): {
  get: Selector<S, T>
  derive<R>(fn: (slice: T) => R): Selector<S, R>
} {
  return {
    get: selector,
    derive<R>(fn: (slice: T) => R): Selector<S, R> {
      return createSelector(selector, fn)
    }
  }
}
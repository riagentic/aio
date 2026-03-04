// Reducer — pure function: (state, action) → new state + effects to run
import type { AppState } from './state.ts'
import { A, type Action } from './actions.ts'
import { E, type Effect } from './effects.ts'
import { draft } from 'aio'

export function reduce(state: AppState, action: Action): { state: AppState; effects: Effect[] } {
  return draft(state, d => {
    switch (action.type) {
      case A.Increment:
        d.counter += action.payload.by
        return [E.log(`incremented by ${action.payload.by} to ${state.counter + action.payload.by}`)]
      case A.Decrement:
        d.counter -= action.payload.by
        return [E.log(`decremented by ${action.payload.by} to ${state.counter - action.payload.by}`)]
      case A.Reset:
        d.counter = 0
        return [E.log("counter reset")]
      default:
        console.warn(`[aio] unknown action: ${(action as { type: string }).type}`)
        return []
    }
  })
}

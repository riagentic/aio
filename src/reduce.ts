// Reducer — pure function: (state, action) → new state + effects to run
import type { AppState } from './state.ts'
import { A, type Action } from './actions.ts'
import { E, type Effect } from './effects.ts'
import { draft } from 'aio'

export function reduce(state: AppState, action: Action): { state: AppState; effects: Effect[] } {
  return draft(state, d => {
    switch (action.type) {
      case A.INCREMENT:
        d.counter += action.payload.by
        return [E.Log(`incremented by ${action.payload.by} to ${state.counter + action.payload.by}`)]
      case A.DECREMENT:
        d.counter -= action.payload.by
        return [E.Log(`decremented by ${action.payload.by} to ${state.counter - action.payload.by}`)]
      case A.RESET:
        d.counter = 0
        return [E.Log("counter reset")]
      default:
        console.warn(`[aio] unknown action: ${(action as { type: string }).type}`)
        return []
    }
  })
}

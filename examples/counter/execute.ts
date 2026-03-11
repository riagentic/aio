// Effect executor — runs side effects (API calls, logging, timers, etc.)
import { E, type Effect } from './effects.ts'
import type { AppState } from './state.ts'
import type { Action } from './actions.ts'
import type { AioApp } from 'aio'

export function execute(_app: AioApp<AppState, Action>, effect: Effect): void {
  switch (effect.type) {
    case E.Log:
      console.log(`[effect] ${effect.payload.message}`)
      break
  }
}

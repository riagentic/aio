// Entry point — wire state + logic, call aio.run(), done
import { aio } from 'aio'
import { initialState } from './state.ts'
import { reduce } from './reduce.ts'
import { execute } from './execute.ts'

await aio.run(initialState, {
  reduce,
  execute,
})

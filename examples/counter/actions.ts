// Actions — sync messages from UI that change state
import { actions, type UnionOf } from 'aio'

export const A = actions({
  Increment: (by = 1) => ({ by }),
  Decrement: (by = 1) => ({ by }),
  Reset: () => ({}),
})

export type Action = UnionOf<typeof A>

// Actions — sync messages from UI that change state (used in both browser and server)
import { msg, type UnionOf } from 'aio'

const T = {
  INCREMENT: "INCREMENT",
  DECREMENT: "DECREMENT",
  RESET: "RESET",
} as const

export const A = {
  ...T,
  Increment: (by = 1) => msg(T.INCREMENT, { by }),
  Decrement: (by = 1) => msg(T.DECREMENT, { by }),
  Reset: () => msg(T.RESET),
} as const

export type Action = UnionOf<typeof A>

// Effects — async side effects returned by the reducer, executed server-side
import { msg, type UnionOf } from 'aio'

const T = {
  LOG: "LOG",
} as const

export const E = {
  ...T,
  Log: (message: string) => msg(T.LOG, { message }),
} as const

export type Effect = UnionOf<typeof E>

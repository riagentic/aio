// Effects — async side effects returned by the reducer, executed server-side
import { effects, type UnionOf } from 'aio'

export const E = effects({
  Log: (message: string) => ({ message }),
})

export type Effect = UnionOf<typeof E>

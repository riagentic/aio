// UI component — just export default, the framework mounts it
import { useAio } from 'aio'
import { A } from './actions.ts'
import type { AppState } from './state.ts'

const btn = {
  padding: '0.75rem 1.5rem',
  fontSize: '1.25rem',
  cursor: 'pointer',
}

export default function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Connecting...</div>

  return (
    <div style={{ padding: '3rem', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
      <h1>AIO Counter</h1>
      <div style={{ fontSize: '4rem', margin: '1rem 0', color: '#00a6cc' }}>
        {state.counter}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
        <button type="button" onClick={() => send(A.decrement())} style={btn}>-</button>
        <button type="button" onClick={() => send(A.reset())} style={btn}>Reset</button>
        <button type="button" onClick={() => send(A.increment())} style={btn}>+</button>
      </div>
    </div>
  )
}

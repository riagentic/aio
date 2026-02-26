// Browser-side aio module — bundled into dist/app.js for prod builds
// Dev mode uses the AIO_UI_JS string in server.ts instead (served at /__aio/ui.js)
import { useState, useEffect, createElement, type ComponentType } from 'react'

const WS_QUEUE_MAX = 100

// Singleton WebSocket — shared across all useAio() calls (one connection per page)
type StateListener = (state: unknown) => void
let _ws: WebSocket | null = null
let _state: unknown = null
let _queue: Array<{ type: string; payload?: unknown }> = []
const _listeners = new Set<StateListener>()
let _retry = 0
let _closed = false

function _notify() { for (const fn of _listeners) fn(_state) }

function _connect() {
  if (_ws || _closed) return
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(proto + '//' + location.host + '/ws')
  ws.onopen = () => {
    _retry = 0
    const q = _queue; _queue = []
    for (const a of q) ws.send(JSON.stringify(a))
  }
  ws.onmessage = (e) => {
    if (e.data === '__reload') return location.reload()
    try {
      const data = JSON.parse(e.data)
      if (data && data.$p) {
        const prev = _state as Record<string, unknown> | null
        const next = prev ? { ...prev, ...data.$p } : data.$p
        if (data.$d) for (const k of data.$d) delete next[k]
        _state = next
      } else {
        _state = data
      }
      _notify()
    } catch (err) { console.warn('[aio] bad state message:', err) }
  }
  ws.onerror = () => {}
  ws.onclose = () => {
    _ws = null
    if (_closed || _listeners.size === 0) return
    const delay = Math.min(1000 * Math.pow(2, _retry), 8000)
    _retry++
    setTimeout(_connect, delay)
  }
  _ws = ws
}

function _send(action: { type: string; payload?: unknown }) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(action))
  } else if (_queue.length < WS_QUEUE_MAX) {
    _queue.push(action)
  } else {
    console.warn('[aio] send queue full, action dropped')
  }
}

/** React hook — connects to server via WS, syncs state, auto-reconnects. Singleton: safe to call from any component. */
export function useAio<S = unknown>(): { state: S | null; send: (action: { type: string; payload?: unknown }) => void } {
  const [state, setState] = useState<S | null>(_state as S | null)

  useEffect(() => {
    const listener: StateListener = (s) => setState(s as S | null)
    _listeners.add(listener)
    if (_state !== null) setState(_state as S | null)
    if (!_ws) { _closed = false; _connect() }
    return () => {
      _listeners.delete(listener)
      if (_listeners.size === 0) {
        _closed = true; _ws?.close(); _ws = null
        _state = null; _queue = []; _retry = 0
      }
    }
  }, [])

  return { state, send: _send }
}

/** Creates { type, payload } objects — kept inline because dev mode serves this as a single transpiled file */
export function msg<T extends string>(type: T): { type: T; payload: Record<string, never> }
export function msg<T extends string, P>(type: T, payload: P): { type: T; payload: P }
export function msg(type: string, payload?: unknown) {
  return { type, payload: payload ?? {} }
}

/** Client-only state — not synced to server, not persisted. For UI-local concerns (editing flags, form inputs, etc.) */
export function useLocal<T>(initial: T): { local: T; set: (next: T | ((prev: T) => T)) => void } {
  const [local, setLocal] = useState<T>(initial)
  return { local, set: setLocal }
}

/** Renders the component matching the current page key. Usage: page(state.page, { home: Home, settings: Settings }) */
export function page<K extends string>(current: K, routes: Record<K, ComponentType>): ReturnType<typeof createElement> | null {
  const Component = routes[current]
  return Component ? createElement(Component) : null
}

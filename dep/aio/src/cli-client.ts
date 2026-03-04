// CLI client — WS state client for Deno (terminal-side equivalent of browser.ts)
// Connects to an aio server via WebSocket, receives state updates, sends actions.
// Same delta protocol as browser.ts but no DOM, no React — pure Deno runtime.

const WS_MAX_QUEUE = 100

/** Reactive WS client handle — subscribe to state, send actions, close when done */
export type CliApp<S> = {
  /** Current state (null until first message from server) */
  readonly state: S | null
  /** Send an action to the server */
  send(action: { type: string; payload?: unknown }): void
  /** Subscribe to state changes — returns unsubscribe function. Fires immediately if state exists. */
  subscribe(fn: (state: S) => void): () => void
  /** Close the connection (no reconnect) */
  close(): void
  /** Whether WS is currently open */
  readonly connected: boolean
  /** Resolves when first state is received */
  readonly ready: Promise<S>
}

/** Connect to an aio server. URL can be http:// or ws:// — protocol is auto-detected. */
export function connectCli<S>(url: string, opts?: { token?: string }): CliApp<S> {
  let state: S | null = null
  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let wasConnected = false
  const queue: Array<{ type: string; payload?: unknown }> = []
  const listeners = new Set<(state: S) => void>()

  let _readyResolve: ((s: S) => void) | null = null
  const ready = new Promise<S>(r => { _readyResolve = r })

  function connect(): void {
    if (ws || closed) return
    const parsed = new URL(url)
    const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = opts?.token
    const wsUrl = `${proto}//${parsed.host}/ws${token ? `?token=${token}` : ''}`

    const socket = new WebSocket(wsUrl)

    socket.onopen = () => {
      retry = 0
      wasConnected = true
      // Drain queued actions
      const q = [...queue]
      queue.length = 0
      for (const a of q) socket.send(JSON.stringify(a))
    }

    socket.onmessage = (e: MessageEvent) => {
      const raw = e.data
      if (typeof raw !== 'string') return

      // Skip browser-only signals
      if (raw === '__reload' || raw === '__css') return
      if (raw.startsWith('__tt:') || raw.startsWith('__boot:')) return

      try {
        const data = JSON.parse(raw)
        if (data === null || typeof data !== 'object') return

        // Delta patch — same protocol as browser.ts
        if (data.$p && typeof data.$p === 'object') {
          const prev = state as Record<string, unknown> | null
          const next: Record<string, unknown> = prev ? { ...prev, ...data.$p } : { ...data.$p }
          if (Array.isArray(data.$d)) {
            for (const k of data.$d) {
              if (typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
                delete next[k]
              }
            }
          }
          state = next as S
        } else {
          state = data as S
        }

        // Resolve ready on first state
        if (_readyResolve) {
          _readyResolve(state)
          _readyResolve = null
        }

        for (const fn of listeners) fn(state)
      } catch { /* bad JSON — skip */ }
    }

    socket.onerror = () => {}

    socket.onclose = () => {
      ws = null
      if (closed) return
      // Exponential backoff: 1s → 2s → 4s → 8s max, ±20% jitter
      const base = Math.min(1000 * Math.pow(2, retry), 8000)
      retry++
      setTimeout(connect, base * (0.8 + Math.random() * 0.4))
    }

    ws = socket
  }

  connect()

  return {
    get state() { return state },
    get connected() { return ws?.readyState === WebSocket.OPEN },
    ready,

    send(action: { type: string; payload?: unknown }): void {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(action))
      } else if (!wasConnected && queue.length < WS_MAX_QUEUE) {
        queue.push(action)
      }
    },

    subscribe(fn: (state: S) => void): () => void {
      listeners.add(fn)
      if (state !== null) fn(state)
      return () => { listeners.delete(fn) }
    },

    close(): void {
      closed = true
      ws?.close()
      ws = null
      listeners.clear()
    },
  }
}

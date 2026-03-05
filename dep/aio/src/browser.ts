/// <reference lib="dom" />
// Browser-side aio module — bundled into dist/app.js for prod builds
// Dev mode uses the AIO_UI_JS string in server.ts instead (served at /__aio/ui.js)
import { useState, useEffect, createElement, type ComponentType } from 'react'

const WS_MAX_QUEUE = 100
const OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000  // 24 hours

// ── Offline queue persistence (IndexedDB) ─────────────────────────────

const _offlineDB = '__aio_offline'
const _offlineStore = 'queue'
const _offlineVersion = 1
interface _QueuedAction { id?: number; action: { type: string; payload?: unknown }; ts: number }
let _idb: IDBDatabase | null = null
let _idbPromise: Promise<IDBDatabase | null> | null = null

function _openIDB(): Promise<IDBDatabase | null> {
  if (_idb) return Promise.resolve(_idb)
  if (_idbPromise) return _idbPromise
  _idbPromise = new Promise<IDBDatabase | null>(resolve => {
    try {
      const req = indexedDB.open(_offlineDB, _offlineVersion)
      req.onerror = () => { _idbPromise = null; resolve(null) }
      req.onsuccess = () => { _idb = req.result; resolve(req.result) }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(_offlineStore)) {
          db.createObjectStore(_offlineStore, { keyPath: 'id', autoIncrement: true })
        }
      }
    } catch { _idbPromise = null; resolve(null) }
  })
  return _idbPromise
}

async function _loadOfflineQueue(): Promise<_QueuedAction[]> {
  const db = await _openIDB()
  if (!db) return []
  return new Promise(resolve => {
    try {
      const tx = db.transaction(_offlineStore, 'readonly')
      const store = tx.objectStore(_offlineStore)
      const req = store.getAll()
      req.onerror = () => resolve([])
      req.onsuccess = () => {
        const actions = req.result as _QueuedAction[]
        const cutoff = Date.now() - OFFLINE_MAX_AGE
        resolve(actions.filter(a => a.ts >= cutoff))
      }
    } catch { resolve([]) }
  })
}

async function _saveOfflineAction(action: { type: string; payload?: unknown }): Promise<void> {
  const db = await _openIDB()
  if (!db) return
  try {
    const tx = db.transaction(_offlineStore, 'readwrite')
    const store = tx.objectStore(_offlineStore)
    store.add({ action, ts: Date.now() })
  } catch { /* best-effort */ }
}

async function _clearOfflineQueue(): Promise<void> {
  const db = await _openIDB()
  if (!db) return
  try {
    const tx = db.transaction(_offlineStore, 'readwrite')
    const store = tx.objectStore(_offlineStore)
    store.clear()
  } catch { /* best-effort */ }
}

// Singleton WebSocket — shared across all useAio() calls (one connection per page)
type StateListener = (state: unknown) => void
let _ws: WebSocket | null = null
let _state: unknown = null
let _queue: Array<{ type: string; payload?: unknown }> = []
const _listeners = new Set<StateListener>()
let _retry = 0
let _closed = false
let _wasConnected = false  // false during initial connect, true after first open
let _offlineReady = false  // true when offline queue loaded from IndexedDB
let _offlineQueue: Array<{ type: string; payload?: unknown }> = []  // persisted actions
let _lastAction: { type: string; payload?: unknown } | null = null  // for DevTools correlation

// Time-travel state — populated when server sends __tt: messages (dev mode)
type TTMeta = { 
  entries: { id: number; type: string; ts: number; perf?: { reduce: number; effects: number; budget: { reduce: number; effect: number } } }[]
  index: number
  paused: boolean 
}
type TTListener = (tt: TTMeta) => void
let _ttState: TTMeta | null = null
const _ttListeners = new Set<TTListener>()

// ── Built-in TT panel (pure DOM, no React) ────────────────────────
// Toggled via Ctrl+. (period), auto-registered on first __tt: message

let _ttPanel: HTMLElement | null = null
let _ttPanelVisible = false
let _ttKeyBound = false

// ── Connection status indicator (pure DOM) ──────────────────────────
let _statusEl: HTMLElement | null = null
let _statusTimer: ReturnType<typeof setTimeout> | null = null
let _statusStyleInjected = false

function _injectStatusStyle(): void {
  if (_statusStyleInjected) return
  _statusStyleInjected = true
  const style = document.createElement('style')
  style.textContent = '@keyframes __aio-pulse{0%,100%{opacity:1}50%{opacity:.5}}'
  document.head.appendChild(style)
}

function _showStatus(text: string, color: string, autohide?: number): void {
  if ((window as unknown as Record<string, unknown>).__aioShowStatus === false) return
  _injectStatusStyle()
  if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null }
  if (!_statusEl) {
    _statusEl = document.createElement('div')
    _statusEl.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99999;'
      + 'font:12px/1 monospace;padding:6px 14px;border-radius:20px;'
      + 'background:rgba(240,240,245,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);'
      + 'border:1px solid rgba(0,0,0,.12);box-shadow:0 4px 16px rgba(0,0,0,.12);'
      + 'transition:opacity .3s;pointer-events:none;'
    document.body.appendChild(_statusEl)
  }
  _statusEl.textContent = text
  _statusEl.style.color = color
  _statusEl.style.opacity = '1'
  _statusEl.style.animation = autohide ? 'none' : '__aio-pulse 2s ease-in-out infinite'
  if (autohide) {
    _statusTimer = setTimeout(() => {
      if (_statusEl) _statusEl.style.opacity = '0'
    }, autohide)
  }
}

function _hideStatus(): void {
  if (_statusEl) _statusEl.style.opacity = '0'
  if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null }
}

function _sendTTCmd(cmd: string): void {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(cmd)
}

function _renderTTPanel(): void {
  if (!_ttState) return

  if (!_ttPanel) {
    _ttPanel = document.createElement('div')
    _ttPanel.id = '__aio-tt'
    _ttPanel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99999;width:280px;max-height:420px;'
      + 'background:rgba(240,240,245,.92);color:#333;border:1px solid rgba(0,0,0,.12);border-radius:10px;'
      + 'font:12px/1.5 monospace;box-shadow:0 8px 32px rgba(0,0,0,.15);display:none;flex-direction:column;'
      + 'overflow:hidden;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);'
    document.body.appendChild(_ttPanel)
  }

  const tt = _ttState
  const atStart = tt.index <= 0
  const atEnd = tt.index >= tt.entries.length - 1

  _ttPanel.innerHTML = ''

  // Header — draggable
  const hdr = document.createElement('div')
  hdr.style.cssText = 'padding:8px 10px;background:rgba(0,0,0,.05);border-bottom:1px solid rgba(0,0,0,.08);'
    + 'display:flex;align-items:center;justify-content:space-between;cursor:grab;'
  hdr.innerHTML = `<span style="color:#666;font-weight:600">⏱ time-travel</span>`
    + `<span style="color:#999;font-size:11px">${tt.index + 1}/${tt.entries.length}${tt.paused ? ' <span style="color:#e25">🔒</span>' : ''}</span>`
  _ttPanel.appendChild(hdr)

  // Drag logic
  let dragX = 0, dragY = 0
  hdr.onmousedown = (e) => {
    e.preventDefault()
    dragX = e.clientX - _ttPanel!.offsetLeft
    dragY = e.clientY - _ttPanel!.offsetTop
    hdr.style.cursor = 'grabbing'
    const onMove = (ev: MouseEvent) => {
      _ttPanel!.style.left = (ev.clientX - dragX) + 'px'
      _ttPanel!.style.top = (ev.clientY - dragY) + 'px'
      _ttPanel!.style.right = 'auto'
      _ttPanel!.style.bottom = 'auto'
    }
    const onUp = () => {
      hdr.style.cursor = 'grab'
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Buttons
  const bar = document.createElement('div')
  bar.style.cssText = 'padding:6px 10px;display:flex;gap:4px;border-bottom:1px solid rgba(0,0,0,.08);'
  const btnStyle = 'padding:3px 8px;border:1px solid rgba(0,0,0,.12);border-radius:5px;background:rgba(0,0,0,.06);'
    + 'color:#444;cursor:pointer;font:11px monospace;'
  const btnDisabled = btnStyle + 'opacity:0.3;cursor:default;pointer-events:none;'

  const mkBtn = (label: string, onclick: () => void, disabled = false): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = disabled ? btnDisabled : btnStyle
    if (!disabled) {
      b.onclick = onclick
      b.onmouseenter = () => { b.style.background = 'rgba(0,0,0,.1)' }
      b.onmouseleave = () => { b.style.background = 'rgba(0,0,0,.06)' }
    }
    return b
  }

  bar.appendChild(mkBtn('◀ undo', () => _sendTTCmd('__tt:undo'), atStart))
  bar.appendChild(mkBtn('redo ▶', () => _sendTTCmd('__tt:redo'), atEnd))
  bar.appendChild(mkBtn(tt.paused ? '🔓 unlock' : '🔒 lock',
    () => _sendTTCmd(tt.paused ? '__tt:resume' : '__tt:pause')))
  _ttPanel.appendChild(bar)

  // Entry list
  const list = document.createElement('div')
  list.style.cssText = 'overflow-y:auto;max-height:300px;padding:4px 0;'
  for (let i = tt.entries.length - 1; i >= 0; i--) {
    const e = tt.entries[i]
    const row = document.createElement('div')
    const isCurrent = i === tt.index
    row.style.cssText = 'padding:3px 10px;cursor:pointer;display:flex;justify-content:space-between;'
      + (isCurrent ? 'background:rgba(0,0,0,.08);color:#111;font-weight:600;' : 'color:#555;')
    row.onmouseenter = () => { if (!isCurrent) row.style.background = 'rgba(0,0,0,.04)' }
    row.onmouseleave = () => { if (!isCurrent) row.style.background = 'transparent' }
    row.onclick = () => _sendTTCmd('__tt:goto:' + e.id)

    const name = document.createElement('span')
    name.textContent = (isCurrent ? '▸ ' : '  ') + e.type
    name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'
    row.appendChild(name)

    // Performance timing (dev mode)
    const right = document.createElement('span')
    right.style.cssText = 'color:#aaa;flex-shrink:0;margin-left:8px;font-size:10px;display:flex;gap:6px;'
    
    if (e.perf) {
      const reduceColor = e.perf.reduce > e.perf.budget.reduce ? '#e25' : '#666'
      const effectColor = e.perf.effects > e.perf.budget.effect ? '#e25' : '#666'
      right.innerHTML = `<span style="color:${reduceColor}">${Math.round(e.perf.reduce)}ms</span>`
        + `<span style="color:${effectColor}">${Math.round(e.perf.effects)}ms</span>`
    } else {
      const d = new Date(e.ts)
      right.textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
    }
    row.appendChild(right)

    list.appendChild(row)
  }
  _ttPanel.appendChild(list)

  // Footer
  const foot = document.createElement('div')
  foot.style.cssText = 'padding:4px 10px;border-top:1px solid rgba(0,0,0,.08);color:#aaa;font-size:10px;text-align:center;'
  foot.textContent = 'Ctrl+. to toggle'
  _ttPanel.appendChild(foot)

  _ttPanel.style.display = _ttPanelVisible ? 'flex' : 'none'
}

function _bindTTKey(): void {
  if (_ttKeyBound) return
  _ttKeyBound = true
  console.log('%c[aio] ⏱ time-travel active — Ctrl+. to toggle panel', 'color:#e94560;font-weight:bold')
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Period') {
      e.preventDefault()
      _ttPanelVisible = !_ttPanelVisible
      if (_ttPanelVisible) _renderTTPanel()
      if (_ttPanel) _ttPanel.style.display = _ttPanelVisible ? 'flex' : 'none'
    }
  })
}

/** Notifies all React subscribers of state change */
function _notify() { for (const fn of _listeners) fn(_state) }

let _bootId: string | null = null  // server boot ID — reload page if server restarted

/** Opens WebSocket connection to server — auto-reconnects with exponential backoff */
function _connect() {
  if (_ws || _closed) return
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const tokenParam = new URLSearchParams(location.search).get('token')
  const wsUrl = proto + '//' + location.host + '/ws' + (tokenParam ? '?token=' + tokenParam : '')
  const ws = new WebSocket(wsUrl)
  ws.onopen = async () => {
    _retry = 0
    if (_wasConnected) _showStatus('Connected', '#2a2', 2000)
    _wasConnected = true
    
    // Flush memory queue (initial connect race)
    const q = _queue; _queue = []
    for (const a of q) ws.send(JSON.stringify(a))
    
    // Load and replay offline queue (persisted during disconnect)
    if (!_offlineReady) {
      const persisted = await _loadOfflineQueue()
      _offlineQueue = persisted.map(p => p.action)
      _offlineReady = true
    }
    if (_offlineQueue.length) {
      console.log(`[aio] replaying ${_offlineQueue.length} offline actions`)
      for (const a of _offlineQueue) ws.send(JSON.stringify(a))
      _offlineQueue = []
      _clearOfflineQueue().catch(() => {})
    }
  }
  ws.onmessage = (e) => {
    if (e.data === '__reload') { _closed = true; ws.close(); return location.reload() }
    if (e.data === '__css') {
      const link = document.querySelector('link[rel="stylesheet"][href*="style.css"]') as HTMLLinkElement | null
      if (link) link.href = '/style.css?t=' + Date.now()
      return
    }
    // Time-travel metadata from server
    if (typeof e.data === 'string' && e.data.startsWith('__tt:')) {
      try {
        _ttState = JSON.parse(e.data.slice(5))
        _bindTTKey()
        for (const fn of _ttListeners) fn(_ttState!)
        if (_ttPanelVisible) _renderTTPanel()
      } catch (err) { console.warn('[aio] bad __tt: data:', err) }
      return
    }
    // Boot ID — reload page if server restarted (stale JS in memory)
    if (typeof e.data === 'string' && e.data.startsWith('__boot:')) {
      const id = e.data.slice(7)
      if (_bootId && _bootId !== id) return location.reload()
      _bootId = id
      return
    }
    try {
      const data = JSON.parse(e.data)
      if (data === null || typeof data !== 'object') {
        console.warn('[aio] unexpected state type:', typeof data)
        return
      }
      if (data.$p && typeof data.$p === 'object') {
        const prev = _state as Record<string, unknown> | null
        const next = prev ? { ...prev, ...data.$p } : data.$p
        if (Array.isArray(data.$d)) for (const k of data.$d) {
          if (typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') delete next[k]
        }
        _state = next
      } else {
        _state = data
      }
      _notify()
      // Notify Redux DevTools if connected
      if (_devtoolsConnected && _lastAction) {
        _sendDevTools(_lastAction, _state)
        _lastAction = null
      }
    } catch (err) { console.warn('[aio] bad state message:', err) }
  }
  ws.onerror = () => { console.warn('[aio] connection error') }
  ws.onclose = () => {
    _ws = null
    if (_closed || _listeners.size === 0) return
    if (_wasConnected) _showStatus('Reconnecting\u2026', '#e25')
    // exponential backoff: 1s → 2s → 4s → 8s max, with ±20% jitter
    const base = Math.min(1000 * Math.pow(2, _retry), 8000)
    _retry++
    console.warn(`[aio] disconnected, retrying in ${(base / 1000).toFixed(1)}s...`)
    setTimeout(_connect, base * (0.8 + Math.random() * 0.4))
  }
  _ws = ws
}

/** Sends action via WS — queues to memory during initial connect, persists to IndexedDB when disconnected */
function _send(action: { type: string; payload?: unknown }) {
  _lastAction = action  // track for DevTools
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(action))
  } else if (!_wasConnected && _queue.length < WS_MAX_QUEUE) {
    // Initial connect race — WS not ready yet
    _queue.push(action)
  } else if (_wasConnected) {
    // Disconnected after initial connection started — persist offline
    _offlineQueue.push(action)
    _saveOfflineAction(action).catch(() => {})  // best-effort
  }
  // else: never connected yet and queue full — drop (WS_MAX_QUEUE safety)
}

// ── Redux DevTools Integration ─────────────────────────────────────

interface DevToolsConnection {
  init: (state: unknown) => void
  send: (action: { type: string; payload?: unknown }, state: unknown) => void
  subscribe: (listener: (message: { type: string; payload?: unknown; state?: string }) => void) => () => void
  disconnect: () => void
}

let _devtools: DevToolsConnection | null = null
let _devtoolsConnected = false

function _initDevTools(): void {
  if (_devtoolsConnected) return
  const ext = (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__
  if (!ext) return
  
  try {
    _devtools = (ext as { connect: () => DevToolsConnection }).connect()
    if (_devtools) {
      _devtoolsConnected = true
      _devtools.subscribe((msg) => {
        if (msg.type === 'DISPATCH') {
          const payload = msg.payload as { type?: string } | undefined
          if (payload?.type === 'JUMP_TO_STATE' || payload?.type === 'JUMP_TO_ACTION') {
            // DevTools time-travel request — we don't have the state history on client
            // The server handles time-travel via TT commands
            console.log('[aio] DevTools time-travel: use Ctrl+. panel for client-side state navigation')
          }
        }
      })
      // Send initial state
      if (_state !== null) {
        _devtools.init(_state)
      }
    }
  } catch {
    // DevTools not available or failed to connect
  }
}

function _sendDevTools(action: { type: string; payload?: unknown }, state: unknown): void {
  if (_devtools && _devtoolsConnected) {
    try {
      _devtools.send(action, state)
    } catch {
      // DevTools disconnected
      _devtoolsConnected = false
    }
  }
}

/** Connect to Redux DevTools extension (call after useAio in dev mode) */
export function connectDevTools(): void {
  _initDevTools()
  if (_devtools && _state !== null) {
    try {
      _devtools.init(_state)
    } catch { /* ignore */ }
  }
}

/** Disconnect from Redux DevTools */
export function disconnectDevTools(): void {
  if (_devtools) {
    try {
      _devtools.disconnect()
    } catch { /* ignore */ }
    _devtools = null
    _devtoolsConnected = false
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

// WHY DUPLICATED: msg() and factory() are inline copies of msg.ts and factory.ts.
// Dev mode serves browser.ts as a single transpiled file (no imports resolved).
// sync.test.ts verifies these stay in sync with the canonical implementations.

/** Creates { type, payload } objects — inline copy (dev mode single-file constraint) */
export function msg<T extends string>(type: T): { type: T; payload: Record<string, never> }
export function msg<T extends string, P>(type: T, payload: P): { type: T; payload: P }
export function msg(type: string, payload?: unknown) {
  return { type, payload: payload ?? {} }
}

/** Creates a typed action/effect catalog — inline copy (dev mode single-file constraint) */
// deno-lint-ignore no-explicit-any
type _Creators = Record<string, (...args: any[]) => any>
type _LowerFirst<S extends string> = S extends `${infer C}${infer Rest}` ? `${Lowercase<C>}${Rest}` : S
type _FactoryResult<T extends _Creators> = {
  readonly [K in keyof T]: K
} & {
  readonly [K in keyof T as _LowerFirst<K & string>]: (...args: Parameters<T[K]>) => { type: K; payload: ReturnType<T[K]> }
}
function _lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}
function _factory<T extends _Creators>(creators: T): _FactoryResult<T> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(creators)) {
    result[key] = key
    result[_lowerFirst(key)] = (...args: unknown[]) => ({ type: key, payload: creators[key](...args) ?? {} })
  }
  return result as _FactoryResult<T>
}
export { _factory as actions, _factory as effects }

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

/** Time-travel hook — returns null in prod mode */
export function useTimeTravel(): {
  entries: { id: number; type: string; ts: number }[]
  index: number
  paused: boolean
  undo: () => void
  redo: () => void
  goto: (id: number) => void
  pause: () => void
  resume: () => void
} | null {
  const [tt, setTT] = useState<TTMeta | null>(_ttState)

  useEffect(() => {
    const listener: TTListener = (t) => setTT({ ...t })
    _ttListeners.add(listener)
    if (_ttState) setTT({ ..._ttState })
    return () => { _ttListeners.delete(listener) }
  }, [])

  if (!tt) return null

  const sendTT = (cmd: string) => {
    if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(cmd)
  }

  return {
    entries: tt.entries,
    index: tt.index,
    paused: tt.paused,
    undo:   () => sendTT('__tt:undo'),
    redo:   () => sendTT('__tt:redo'),
    goto:   (id: number) => sendTT('__tt:goto:' + id),
    pause:  () => sendTT('__tt:pause'),
    resume: () => sendTT('__tt:resume'),
  }
}

/** Resets module state — for testing only */
export function _reset(): void {
  _closed = true
  _ws?.close()
  _ws = null
  _state = null
  _queue = []
  _retry = 0
  _closed = false
  _listeners.clear()
  _ttState = null
  _ttListeners.clear()
  _ttPanel?.remove()
  _ttPanel = null
  _ttPanelVisible = false
  _statusEl?.remove()
  _statusEl = null
  if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null }
  _wasConnected = false
  _bootId = null
}

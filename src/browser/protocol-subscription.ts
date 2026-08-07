// deno-lint-ignore-file
// Subscription management, listener state, vitals runtime state, state readiness.

import { Listeners } from "../state/listeners.ts";
import {
  _getState as _coreGetState,
  isInitialStateReceived as _coreHasState,
} from "../state-core.ts";
import { _diagEmit } from "../protocol/protocol-diagnostics.ts";
import type { RenderMeterAPI } from "../vitals/render-meter.ts";
import type { createTransportProbeClient } from "../vitals/transport-probe.ts";

// ── Vitals / render meter state ─────────────────────────────────────

export let _vitalsRenderMeter: RenderMeterAPI | null = null;
export function _setVitalsRenderMeter(v: RenderMeterAPI | null): void {
  _vitalsRenderMeter = v;
}
export let _vitalsUrlLogged = false;
export function _setVitalsUrlLogged(v: boolean): void {
  _vitalsUrlLogged = v;
}
export let _vitalsTransportProbe:
  | ReturnType<typeof createTransportProbeClient>
  | null = null;
export function _setVitalsTransportProbe(
  v: typeof _vitalsTransportProbe,
): void {
  _vitalsTransportProbe = v;
}
export let _vitalsPingTimer: ReturnType<typeof setInterval> | null = null;
export function _setVitalsPingTimer(v: typeof _vitalsPingTimer): void {
  _vitalsPingTimer = v;
}
export const _useAioWarned = new Set<string>();
export let _useAioActiveCount = 0;
export function _setUseAioActiveCount(n: number): void {
  _useAioActiveCount = n;
}
export let _cleanupTimer: ReturnType<typeof setTimeout> | null = null;
export function _setCleanupTimer(v: typeof _cleanupTimer): void {
  _cleanupTimer = v;
}
export let _listenerHighWater = 0;
export function _setListenerHighWater(n: number): void {
  _listenerHighWater = n;
}

// ── State notification ──────────────────────────────────────────────

export const _listeners = new Listeners<unknown>();

export function _notify() {
  _listeners.notify(_coreHasState() ? _coreGetState() : null);
}

// ── State version & readiness ───────────────────────────────────────

export let _stateVersion = 0;
export function _incStateVersion(): void {
  _stateVersion++;
}
export function _resetStateVersion(): void {
  _stateVersion = 0;
}

let _stateReadyResolve: (() => void) | null = null;
let _stateReadyPromise: Promise<void> | null = null;

/** Called from _notify() when state first arrives — resolves the readiness promise. */
export function _resolveStateReady(): void {
  if (_stateReadyResolve) {
    _stateReadyResolve();
    _stateReadyResolve = null;
    _stateReadyPromise = null;
  }
}

export function _resetStateReady(): void {
  _stateReadyPromise = null;
  _stateReadyResolve = null;
}

// _waitForState needs _connect — injected from browser.ts
let _connectFn: (() => void) | null = null;
export function _setConnectFn(fn: () => void): void {
  _connectFn = fn;
}

export function _callConnectFn(): void {
  if (_connectFn) _connectFn();
}

export function _waitForState(): Promise<void> {
  if (_coreHasState()) return Promise.resolve();
  if (!_stateReadyPromise) {
    _stateReadyPromise = new Promise<void>((resolve) => {
      _stateReadyResolve = resolve;
    });
  }
  if (_connectFn) _connectFn();
  return _stateReadyPromise;
}

// ── Subscription management ─────────────────────────────────────────

export const _useAioSubscribe = (onStoreChange: () => void): () => void => {
  _useAioActiveCount++;
  const unsub = _subscribe(onStoreChange);
  return () => {
    _useAioActiveCount--;
    unsub();
  };
};

// _subscribe needs _connect, _rSync, _popstateHandler — injected
let _subscribeTriggerConnect: (() => void) | null = null;
let _subscribeTriggerPopstate: (() => void) | null = null;
export function _setSubscribeTriggers(
  connect: () => void,
  popstate: () => void,
): void {
  _subscribeTriggerConnect = connect;
  _subscribeTriggerPopstate = popstate;
}

export function _subscribe(onStoreChange: () => void): () => void {
  const unsub = _listeners.add(() => {
    onStoreChange();
  });
  if (_listeners.size > _listenerHighWater) {
    _listenerHighWater = _listeners.size;
  }
  if (_subscribeTriggerConnect) {
    _subscribeTriggerConnect();
  }
  return () => {
    unsub();
    if (_listeners.size === 0) {
      if (_cleanupTimer) clearTimeout(_cleanupTimer);
      const peakCount = _listenerHighWater;
      _cleanupTimer = setTimeout(() => {
        _cleanupTimer = null;
        if (_listeners.size === 0) {
          console.warn(
            `[aio] teardown — no listeners for 300ms (peak was ${peakCount}). Closing connection, clearing state.`,
          );
          _diagEmit({
            type: "teardown",
            severity: "warning",
            source: "browser",
            message: "Full teardown — no listeners remained after grace period",
            detail: { graceMs: 300, peakListenerCount: peakCount },
          });
          // Trigger full teardown via browser.ts callback
          if (_teardownFn) _teardownFn();
        } else {
          console.warn(
            `[aio] teardown averted — listeners dropped to 0 but recovered to ${_listeners.size} within 300ms`,
          );
          _diagEmit({
            type: "teardown-averted",
            severity: "info",
            source: "browser",
            message: "Transient listener gap — teardown cancelled",
            detail: { recoveredCount: _listeners.size },
          });
        }
      }, 300);
    }
  };
}

let _teardownFn: (() => void) | null = null;
export function _setTeardownFn(fn: () => void): void {
  _teardownFn = fn;
}

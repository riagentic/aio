// deno-lint-ignore-file
// Connection status indicator — pure DOM overlay widget.

let _statusEl: HTMLElement | null = null;
let _statusTimer: ReturnType<typeof setTimeout> | null = null;
let _statusStyleInjected = false;

function _injectStatusStyle(): void {
  if (_statusStyleInjected) return;
  _statusStyleInjected = true;
  const style = document.createElement("style");
  style.textContent =
    "@keyframes __aio-pulse{0%,100%{opacity:1}50%{opacity:.5}}";
  document.head.appendChild(style);
}

export function _showStatus(
  text: string,
  color: string,
  autohide?: number,
): void {
  if (
    (window as unknown as Record<string, unknown>).__aioShowStatus === false
  ) return;
  _injectStatusStyle();
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
  if (!_statusEl) {
    _statusEl = document.createElement("div");
    _statusEl.style.cssText =
      "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99999;" +
      "font:12px/1 monospace;padding:6px 14px;border-radius:20px;" +
      "background:rgba(240,240,245,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);" +
      "border:1px solid rgba(0,0,0,.12);box-shadow:0 4px 16px rgba(0,0,0,.12);" +
      "transition:opacity .3s;pointer-events:none;";
    document.body.appendChild(_statusEl);
  }
  _statusEl.textContent = text;
  _statusEl.style.color = color;
  _statusEl.style.opacity = "1";
  _statusEl.style.animation = autohide
    ? "none"
    : "__aio-pulse 2s ease-in-out infinite";
  if (autohide) {
    _statusTimer = setTimeout(() => {
      if (_statusEl) _statusEl.style.opacity = "0";
    }, autohide);
  }
}

export function _hideStatus(): void {
  if (_statusEl) _statusEl.style.opacity = "0";
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
}

/** Reset status UI state — for _reset() */
export function _resetStatus(): void {
  _statusEl?.remove();
  _statusEl = null;
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
}

// desktop-print.ts — `print()`: the page's print dialog, on every client.
//
// `window.print()` is a silent no-op in an aio Electron window on Linux
// (Electron 41+): nothing opens, nothing is said. The window's main process
// can print (`webContents.print`, what its Ctrl+P does), and the preload
// exposes that as `__aioShell.print()` (both shells; `__aioIPC.print()` in the
// IPC one too) — which was undocumented, so an app had
// to find it in the source. One call: the IPC in an aio Electron window,
// `window.print()` everywhere else. `@media print` and `beforeprint` apply
// either way: both print the page the renderer shows.

/** Open the print dialog for this page. In an aio desktop window it is
 *  printed by the window's main process (Linux has no working
 *  `window.print()` there); in a browser it is `window.print()`. Throws
 *  where there is no page to print (a server, a script).
 *
 *  @example
 *  ```tsx
 *  import { print } from "aio/air";
 *  <button type="button" onClick={() => print()}>Print</button>
 *  ```
 */
export function print(): void {
  const g = globalThis as {
    __aioShell?: { print?: () => void };
    __aioIPC?: { print?: () => void };
    print?: () => void;
  };
  // Both desktop shells (WebSocket and IPC) carry __aioShell.print.
  const desk = g.__aioShell?.print ?? g.__aioIPC?.print;
  if (typeof desk === "function") desk();
  else if (typeof g.print === "function") g.print();
  else {
    throw new Error(
      "print(): there is no page to print here — call it from the UI " +
        "(a click handler), not from server code",
    );
  }
}

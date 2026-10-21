// desktop-print.ts — `print()`: the page's print dialog, on every client.
//
// `window.print()` is a silent no-op in an aio Electron window on Linux
// (Electron 41+): nothing opens, nothing is said. The window's main process
// can print (`webContents.print`, what its Ctrl+P does), and the preload
// exposes that as `__aioIPC.print()` — which was undocumented, so an app had
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
    __aioIPC?: { print?: () => void };
    print?: () => void;
  };
  if (typeof g.__aioIPC?.print === "function") g.__aioIPC.print();
  else if (typeof g.print === "function") g.print();
  else {
    throw new Error(
      "print(): there is no page to print here — call it from the UI " +
        "(a click handler), not from server code",
    );
  }
}

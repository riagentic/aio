# Clients

How browsers, Electron, and CLI tools connect to AIO.

- [CLI toolkit](cli-toolkit.md) — `aio/cli`: typed args + generated `--help`,
  prompts that refuse without a TTY, table/progress/spinner/style, `watch()`
  live view, exit codes
- [Browser](browser.md) — WebSocket client, connection lifecycle
- [Electron](electron.md) — desktop setup, UDS, packaging
- [Embedding a web page](webview.md) — `<Browser>`: somebody else's page inside
  your app, with the navigation loop and the destroyed-login trap closed
- [Transports](transports.md) — the matrix: what listens (TCP, UDS, none) per
  mode × client × OS, zero ports by default and `--port` as the opt-out,
  `routes` vs `serverFn`, the trojan port
- [Desktop jobs](desktop-jobs.md) — the app that drives a CLI: native file
  dialogs, `spawn` (pause/resume/cancel, process-group safe), `long` methods
- [Binary side channels](binary-streams.md) — a sustained binary stream (media,
  telemetry, remote input) over your own WS route: framing, per-kind sequencing,
  backpressure, gap detection
- [App Manager](app-manager.md) — am commands, inspection, dispatch
- [amui](amui.md) — Aio Manager UI, the visual app manager (GUI counterpart to
  `am`)

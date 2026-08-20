# Clients

How browsers, Electron, and CLI tools connect to AIO.

- [Browser](browser.md) — WebSocket client, connection lifecycle
- [Electron](electron.md) — desktop setup, UDS, packaging
- [Desktop jobs](desktop-jobs.md) — the app that drives a CLI: native file
  dialogs, `spawn` (pause/resume/cancel, process-group safe), `long` methods
- [Binary side channels](binary-streams.md) — a sustained binary stream (media,
  telemetry, remote input) over your own WS route: framing, per-kind sequencing,
  backpressure, gap detection
- [App Manager](app-manager.md) — am commands, inspection, dispatch
- [amui](amui.md) — Aio Manager UI, the visual app manager (GUI counterpart to
  `am`)

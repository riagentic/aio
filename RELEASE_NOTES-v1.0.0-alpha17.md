# v1.0.0-alpha17 — external-audit hardening + experimental targets

An external code audit of the whole tree (verified in full: suite, coverage,
security regression) plus honest labeling of what isn't field-proven yet.
Staying on the alpha track — beta is deferred until the remote targets are
validated off-box.

## ✨ Highlights

- **Security hardening** — the dev HTML shell sanitizes `ui.entry` before
  interpolation (self-XSS guard); the localhost trojan's read-only SQL gate now
  admits `WITH … SELECT` CTEs while staying read-only.
- **Deterministic CRDT ordering** — sync ops order by
  `hlc_phys, hlc_cnt,
  hlc_node`, giving a stable total order across nodes.
- **Memory fixes** — renderer signal-bindings clean up on unmount; the
  dispatch-storm detector evicts quiet action types so its map can't grow
  unbounded on a long-running server.
- **UDS zombie detection** — instance liveness now covers the Unix-socket
  transport (`isSocketAlive`), matching the TCP port check.
- **Remote targets marked experimental** — the five `remote`/thin-client targets
  build and run but aren't yet field-validated off-box; flagged in the docs, the
  scaffolder menu, and a build-time notice. The five local targets (browser,
  electron, cli, android, service) are the validated, stable set.
- `VirtualListConfig.containerRef` — `scrollToIndex` moves the real scrollbar.

## 📦 Since alpha15 (alpha16 recap)

`deno task doctor` config checker (+ `./doctor` export) · `schedule.backoff` ·
compose-time **field-filter security warnings** (non-top-level exclude keys,
secret-looking exposed fields) · dispatch-overflow rejects + SQL ORDER BY guard
· aiol false-positive fixes · dead code removed (`boot/`, error-overlay,
pre-split browser transport) · honest install docs — both field reports fully
resolved.

Full details in `CHANGELOG.md`.

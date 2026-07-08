# Road to 1.0.0-final

Plan written 2026-07-04. **Core principle:** all breaking changes die in alpha;
beta = frozen surface, bugfix-only; 1.0.0 = boring. Commit per task as
`rd(<task-id>): <summary>`. Shipped work lives in `CHANGELOG.md` — this file
tracks only what remains.

---

## Shipped (through v1.0.0-alpha15)

- **Phase A (alphas)** — A1 public-surface audit, A2 API-snapshot gate, A3 WS
  protocol handshake, A4 persistence schema versioning, A5 `air/compat`
  permanent. A6 field reports: TUI/desktop, AIR/canvas, android (real emulator),
  browser + electron (real chromium/window), multi-client sync concurrency — all
  done **except the off-box remote report** (below).
- **Phase B gates** — B2 docs-coverage gate, B3 error-message audit, B4 bench +
  soak harness, B5 security pass, B7 kata test sweep (per-target examples +
  coverage ratchet), B8 watcher-feedback-loop hardening.
- **src/ folderized** with the CI-enforced boundary gate.

## Remaining before 1.0

- [ ] **A6 — off-box remote field report.** Same-box remote validated (exposed
      TLS+token server ↔ remote-cli, AIO-403 fixed). Remaining: a real
      **deployed (off-box)** server + client session on the frozen API, plus
      `electron:remote` / `android:remote` device smokes.
- [ ] **B1 — beta1 = feature freeze.** API snapshot locked ✓, semver +
      deprecation policy ✓ (`docs/basics/semver-policy.md`). Remaining: the
      freeze decision + the beta1 release itself.
- [ ] **B4 — the 72h soak run.** Harness ready (`deno task soak:72h`, heap-slope
      leak gate); 30-min run clean. Remaining: the actual 72h run.
- [ ] **B6 — beta2+ = fixes only** + 2 more field-report apps on the frozen API.

## Phase C — 1.0.0 exit criteria (defined now, not negotiated later)

- [ ] **C1** — API snapshot unchanged across ≥2 consecutive betas.
- [ ] **C2** — Latest 2 field reports contain zero P1/P2 (only "worked well").
- [ ] **C3** — All templates × app types scaffold + build + run in CI.
- [ ] **C4** — `docs/upgrade/from-beta-to-1.0.0.md` + stability statement
      (what's guaranteed, what's `@experimental`).

## Post-1.0 insurance (policy, not tasks)

- Additive-only evolution: new features behind new exports/options, never
  changed semantics.
- `@experimental` tag = the only escape hatch for unstable surface.
- Keep the field-report ritual; pin field-report keep-lists as tests where
  possible.

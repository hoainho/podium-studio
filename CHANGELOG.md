# Changelog

All notable changes to Podium Studio are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-07-17
First public trial release.

### Added
- **Non-technical test authoring** — build flows in plain steps (tap / type /
  check); no code required.
- **Deterministic mobile E2E** — iOS Simulator and Android, driven by the
  Podium engine (no AI in the run path).
- **Web E2E** — run the same style of test in a real browser, with:
  - frame-aware element resolution (finds targets inside cross-origin iframes),
  - automatic cookie/consent-overlay dismissal,
  - intelligent wait-until-visible for late-loading content,
  - per-step screenshots, a full trace, and a video of every run.
- **Evidence-first runs** — every step shows before/after screenshots; failures
  come with an actionable diagnosis instead of a raw timeout.
- **Self-healing selectors** and AI-assisted authoring.
- **Bilingual UI** — English and Vietnamese, with full layout-safety in both.
- **Local-first desktop app** (macOS) with an in-app keychain for API keys.

[0.1.0]: https://github.com/hoainho/podium-studio/releases/tag/v0.1.0

# Architecture

Podium Studio is a **local-first desktop app**. Everything runs on the tester's
machine — no cloud account is required to author or run tests.

```
┌───────────────────────────────────────────────────────────┐
│  Desktop shell (Tauri v2, native webview)                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  UI (React + TypeScript)                             │   │
│  │  authoring · run timeline · evidence · diagnostics   │   │
│  └───────────────┬─────────────────────────────────────┘   │
│                  │  HTTP + WebSocket (localhost:8787)        │
│  ┌───────────────▼─────────────────────────────────────┐   │
│  │  Local bridge (Node: Express + ws)                   │   │
│  │  validates flows · orchestrates runs · streams events │   │
│  └───────┬───────────────────────────┬──────────────────┘   │
│          │ mobile                     │ web                   │
│  ┌───────▼─────────┐         ┌────────▼───────────────┐      │
│  │ Podium engine    │        │ Playwright (default)    │      │
│  │ (deterministic;  │        │ / CloakBrowser fallback │      │
│  │  iOS sim/Android)│        │  (web E2E, frame-aware) │      │
│  └──────────────────┘        └─────────────────────────┘      │
│  Local SQLite (run history + artifacts index) · OS keychain   │
└───────────────────────────────────────────────────────────┘
```

## Key pieces
- **Flow IR** (`shared/`) — a small, Zod-validated intermediate representation of
  a test: an ordered list of steps (`tap`, `type`, `waitFor`, `assertVisible`,
  `openLink`, `scrollUntilVisible`, …). The same IR drives every platform.
- **Bridge** (`bridge/`) — a local Node server. It validates a flow, expands
  sub-flows, runs it through the right driver, streams `run:start` / `step:*` /
  `run:end` events to the UI over WebSocket, and persists a run report.
- **Drivers** — mobile flows go to the **Podium engine** (deterministic; no AI in
  the run path). Web flows go to **Playwright** (default) with a CloakBrowser
  fallback for bot-protected sites — see [WEB-TESTING.md](./WEB-TESTING.md).
- **Evidence** — per-step screenshots, a full trace, and a video are captured per
  run and served back to the UI timeline.
- **Storage** — a two-tier local SQLite store keeps run history and an artifacts
  index; nothing leaves the machine. Secrets live in the OS keychain.

## Determinism
The mobile run path contains **no AI** — it orchestrates the Podium engine's
deterministic tools so the same flow produces the same actions every time. AI is
optional and confined to *authoring assistance* and *self-healing suggestions*,
never the pass/fail decision.

## Build gate
`tsc` for both the app (`tsconfig.json`) and the Node bridge
(`tsconfig.node.json`), plus the `vitest` suite, must be green.

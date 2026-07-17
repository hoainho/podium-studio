# Contributing to Podium Studio

Thank you for your interest! Podium Studio is currently a **proprietary trial**
(see [LICENSE](./LICENSE)), so contribution is intentionally limited during this
phase.

## What's welcome now
- **Bug reports** — open an issue with clear steps to reproduce, your OS, the
  app version, and (if a run failed) the step timeline / trace.
- **Feature ideas & feedback** — open an issue describing the outcome you want.
- **Security reports** — please follow [SECURITY.md](./SECURITY.md) (report
  privately, not as a public issue).

## What's not open yet
External code contributions (pull requests) are **not** accepted during the
trial, because the codebase is proprietary and under active shaping. This may
change with future licensing.

## If you're evaluating the source
Handy scripts (require Node 22+):

```bash
npm install
npm run typecheck   # tsc for both the app and the Node bridge
npm test            # vitest
```

Please keep any local experiments to your own fork and within the terms of the
LICENSE.

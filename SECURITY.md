# Security Policy

## Reporting a vulnerability
If you discover a security issue in Podium Studio, please report it privately —
do **not** open a public issue. Open a GitHub security advisory (Security →
Report a vulnerability) or contact the maintainer directly. You'll get an
acknowledgement within a few business days.

## How Podium Studio handles secrets
Podium Studio is local-first and treats credentials as first-class secrets:

- **API keys** (e.g. an AI provider key) are stored in the OS keychain, never in
  plaintext config and never committed to a project.
- **Test-account passwords** are referenced indirectly (`${secret:name}`) and
  resolved at run time; the raw value never lands in a flow file, a run report,
  or a log.
- **Run artifacts and logs** are scrubbed of known secret patterns before they
  are written or displayed.
- The repository ships **no** credentials. `.env`, `data/`, and run `artifacts/`
  are git-ignored.

## Scope
This policy covers the Podium Studio application in this repository. Third-party
dependencies are covered by their own projects' security policies.

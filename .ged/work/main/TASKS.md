# Tasks: Modernize GedPi runtime contracts

## Slice 1 — Baseline and dependency install

- [x] Run focused baseline checks and capture npm audit paths.
- [x] Install aligned Pi 0.84.1, pi-subagents 0.45.1, and pi-intercom 0.10.0.
- [x] Confirm exact dependency tree and extension entrypoints.

## Slice 2 — Compatibility and maximum reasoning

- [x] Add failing focused expectations for `max` thinking and current package
  versions/contracts.
- [x] Update settings/commands to round-trip and emit `max`.
- [x] Remove unsupported `maxFinalizationTurns` from prompts, docs, and tests.
- [x] Reconcile current subagent result/config APIs only where tests or public
  contracts require it.

## Slice 3 — Verification and release notes

- [x] Run focused tests and full project verification.
- [x] Resolve only compatible reachable high-severity audit paths.
- [x] Update `CHANGELOG.md` and dependency/orchestration documentation.
- [x] Review final diff and create a conventional commit.

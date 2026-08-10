# Spec: Modernize GedPi runtime contracts

## Goal

Update the canonical GedPi repository from Pi 0.82.1, pi-subagents 0.37.2, and
pi-intercom 0.6.0 to the approved current runtime set while preserving behavior,
adopting current public contracts, adding maximum-reasoning compatibility, and
clearing reachable high-severity npm advisories.

## Scope

- Align `@earendil-works/pi-*` and `@mariozechner` npm aliases on 0.84.1.
- Update pi-subagents to 0.45.1 and pi-intercom to 0.10.0.
- Remove unsupported `acceptance.maxFinalizationTurns` guidance.
- Add canonical `max` thinking support without removing legacy `xhigh`.
- Reconcile only compatibility changes required by the installed packages.
- Update focused tests, docs, and Unreleased changelog.

## Non-goals

- Do not implement work-mode governance, task identity, adaptive role selection,
  or durable-memory simplification in this slice.
- Do not broadly update unrelated dependencies or add compatibility fallbacks.

## Acceptance

- Requested packages resolve exactly with valid peers.
- GPT-5.6 Luna + `thinking: max` can be configured and emitted.
- Current acceptance examples contain only supported public fields.
- Focused tests, `npm audit --audit-level=high`, and `npm run verify` pass.

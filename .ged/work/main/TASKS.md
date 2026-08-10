# Tasks: Task-scoped governance kernel

## Slice 1 — Pure governance resolver

- [x] Add the canonical governance vocabulary and pure resolver contract.
- [x] Add and verify the required scenario matrix.

## Slice 2 — Task identity and per-request selection

- [x] Add generated work IDs, session-scoped pointers, and active path lookup.
- [x] Add atomic bootstrap/open/continue and binding validation operations.
- [x] Register the current-request transition tool and fail-closed write guard.
- [x] Add focused path, concurrency, and extension lifecycle tests.
- [x] Run focused tests, typecheck, formatting, lint, and independent review.
- [x] Commit the bounded slice.

## Later slices

- [ ] Add one authoritative structured state with serialized CAS updates.
- [ ] Add fail-closed legacy-state migration and quarantine.
- [ ] Decouple remaining guards from staffing and migrate prompts/status.
- [ ] Add explicit lifecycle transitions and remove commit auto-close.

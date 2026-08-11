# TASKS: GedPi 0.20.0 native-tool governance and release

## Stop policy

Stop without release if the real Plannotator surface does not open and approve this canonical plan, a native tool disappears, any required check remains failing, status contains an unexplained change, the exact staged/package diff is not acceptable, push fails, or workflow/GitHub/npm publication cannot be established.

## 1. Obtain and bind plan approval

- [ ] Open this exact `TASKS.md` with `gedpi_plan_review` and confirm a visual review surface opens.
- [ ] Incorporate requested changes and repeat visual review if denied or changed.
- [ ] After explicit approval only, call `ged_governance accept-plan` to bind exact `SPEC.md`, `TASKS.md`, and `TESTS.md` bytes.
- Done when authoritative accepted-plan evidence exists for the visually approved current bytes before any source mutation.

## 2. Inventory baseline and affected surfaces

- [ ] Explain initial branch/HEAD/status and distinguish pre-existing changes from this work.
- [ ] Locate `isAuditedReadOnlyBash`, its parser and callers, mutation snapshot logic, plan-review bridge, package/runtime tests, release workflow, and documentation references to Codex conversion.
- [ ] Record baseline focused/full test counts where practical without masking failures.
- Done when implementation locations, relevant tests, and any unrelated changes are known; unexplained changes trigger the stop policy.

## 3. Harden native read-only Bash policy

- [ ] Implement a narrow allowlist/parser for bounded `pwd`, `uname`, `git status`, `git rev-parse`, safe `git diff` including `--check`, `git log`, `git show`, and `git branch --show-current` forms.
- [ ] Reject shell composition/escapes/redirection/substitution, mutating or ambiguous Git syntax/options, and npm scripts.
- [ ] Preserve conservative pre/post snapshot observation for unknown and mutation-capable tools.
- [ ] Add positive and adversarial classifier/caller regression tests.
- Done when focused governance/runtime tests prove allowed inspections bypass mutation requirements while adversarial and unknown tools fail closed or remain observed.

## 4. Remove Codex conversion completely

- [ ] Remove `@howaboua/pi-codex-conversion` from `package.json` and regenerate `package-lock.json` through npm.
- [ ] Confirm it is absent from `pi.extensions`, installed dependency resolution, and package artifacts.
- [ ] Rewrite stale runtime/package tests and docs to assert Pi-native `read`, `bash`, `write`, and `edit`, with no `exec_command`/`apply_patch` aliases or compatibility extension.
- [ ] Add manifest/lock/packed-output regression assertions.
- Done when repository and pack checks contain no active conversion dependency/reference except historical changelog context that is explicitly historical.

## 5. Prove Plannotator planned-work reliability

- [ ] Inspect the existing `gedpi_plan_review` bridge and current public Plannotator/Pi APIs.
- [ ] Keep `@plannotator/pi-extension` configured and packaged.
- [ ] Add focused coverage showing `gedpi_plan_review` is registered during planned work before `ged_governance accept-plan` and enforcing final-plan -> visual-review -> acceptance -> mutation ordering.
- [ ] If public APIs expose trustworthy review/content identity, bind approval to exact plan bytes and test stale approval rejection; otherwise add the strongest deterministic integration test and document the public-API limitation.
- Done when the actual review in task 1 and deterministic automated coverage both pass without private shims.

## 6. Add isolated end-to-end smoke coverage

- [ ] Prove read-only Bash inspection works without mutating work.
- [ ] Prove direct-change open/mutation/verification behavior.
- [ ] Prove planned-change review availability, accepted plan binding, source mutation, verification, commit milestone behavior, and explicit lifecycle completion.
- [ ] Prove native `read`, `bash`, `write`, and `edit` remain available and unknown mutation-capable tools stay snapshot-observed.
- Done when isolated smoke tests pass without altering user/global runtime state or relying on stale approvals.

## 7. Prepare 0.20.0 release metadata

- [ ] Add user-facing Fixes/Dependencies/Documentation notes, rename the current Unreleased body to `0.20.0 - 2026-08-11`, and create a fresh Unreleased section.
- [ ] Set root package and lockfile version to 0.20.0 using the repository's versioning process without an automatic Git tag.
- [ ] Ensure release/package documentation reflects native tools and retained Plannotator behavior.
- Done when metadata is internally consistent and no release artifact includes the removed conversion package.

## 8. Run and adjudicate every release gate

- [ ] Run `npm run format`, inspect resulting changes, then run `npm run check` and `npm run lint`.
- [ ] Run focused governance, runtime, plan-review, smoke, and package tests and record passed test files/tests.
- [ ] Run `npm run verify`, `npm audit --audit-level=high`, and `npm run pack:check`.
- [ ] Build the exact tarball, install it into a fresh temporary project, and verify package metadata plus extension loading with native tools and Plannotator present and conversion absent.
- [ ] Run `git diff --check`; explain final status and remove only generated artifacts from this work.
- [ ] Review the complete unstaged/staged diff and packed file list for secrets, unrelated files, forbidden aliases/extensions, nested `node_modules`, lockfiles, or dependency links.
- Done only when every required gate passes and every remaining change belongs to this work.

## 9. Verify, commit, tag, push, and confirm publication

- [ ] Stage only observed work-scope paths.
- [ ] Call `ged_governance record-verification` with argv-based gate commands, clean review findings, package/install evidence, and residual risks for the exact staged snapshot.
- [ ] Create the conventional `chore: release gedpi 0.20.0` commit without auto-staging and prove HEAD/tree matches the verified snapshot.
- [ ] Create annotated or lightweight tag `gedpi-v0.20.0` on that exact commit after confirming the tag does not already conflict.
- [ ] Push the release commit and exact tag without force.
- [ ] Confirm the repository release workflow succeeds, the GitHub release exists for that tag, and npm reports `gedpi@0.20.0` as published.
- [ ] Explicitly complete this work with `ged_lifecycle` only after current verification and established publication status.
- Done when local commit/tag identity, remote branch/tag identity, successful workflow, GitHub release, and npm publication all agree; otherwise report the exact blocker and do not claim release success.

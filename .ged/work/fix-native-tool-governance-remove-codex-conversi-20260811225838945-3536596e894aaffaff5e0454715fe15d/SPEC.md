# SPEC: GedPi 0.20.0 native-tool governance and release

## Objective

Correct the failed self-assessment by making GedPi work with Pi-native tools, completely removing `@howaboua/pi-codex-conversion`, preserving conservative governance for unknown mutation-capable tools, proving the configured Plannotator planned-work path, and releasing GedPi 0.20.0 only after every required gate and remote publication check succeeds.

## Required behavior

### Native read-only Bash classification

- Inspect `isAuditedReadOnlyBash` and every authorization/snapshot caller before changing policy.
- Permit only syntactically bounded, genuinely read-only forms of `pwd`, `uname`, `git status`, `git rev-parse`, non-mutating `git diff` (including `--check`), `git log`, `git show`, and `git branch --show-current`.
- Keep fail-closed rejection for command chaining, redirection, command substitution, shell escapes, mutating Git subcommands/options, ambiguous syntax, and npm scripts.
- Preserve snapshot observation for unknown or mutation-capable tools; no tool-name compatibility aliases or replacement compatibility extension may be added.
- Add table-driven positive and adversarial tests covering classifier boundaries and its runtime callers.

### Codex conversion removal

- Remove `@howaboua/pi-codex-conversion` from the root manifest and lockfile and confirm it is absent from `pi.extensions`.
- Remove or rewrite stale tests and documentation that imply Codex requires converted tool names.
- Keep native `read`, `bash`, `write`, and `edit` as the supported Codex/Pi tool surface.
- Add deterministic manifest/lock/pack assertions that the removed package name and files are absent.

### Plannotator reliability

- Keep `@plannotator/pi-extension` configured in `pi.extensions`, skills, dependencies, and the packed package.
- Use the real `gedpi_plan_review` tool on this work's canonical `TASKS.md` before plan acceptance. If the visual surface fails to open, the tool is blocked, or approval is not explicit, stop without accepting the plan, implementing, tagging, or publishing.
- Prove the intended order: final plan bytes -> visual decision -> `ged_governance accept-plan` -> source mutation.
- Inspect only public Pi/Plannotator APIs for a safe way to bind approval to the current plan bytes. If supported, implement and test exact-byte stale-approval rejection. If unsupported, retain the existing prompt/tool policy, add the strongest deterministic public-API integration coverage available, and document the residual limitation without a private shim.

### Smoke coverage

Exercise in isolated fixtures or temporary repositories:

1. read-only inspection without opening work;
2. direct-change governed mutation and verification;
3. planned-change through real or public-API-faithful Plannotator review, exact plan acceptance, source mutation, verification, commit/lifecycle behavior;
4. availability of native `read`, `bash`, `write`, and `edit`;
5. conservative snapshot observation for unknown mutation-capable tools.

### Release 0.20.0

- Update version metadata and lockfile to 0.20.0 using the established npm/version process without creating an implicit tag.
- Convert current Unreleased notes into `0.20.0 - 2026-08-11`, add a fresh Unreleased section, and describe native-tool governance, conversion removal, Plannotator assurance, and any documented limitation.
- Review the exact staged diff and `npm pack` contents. No unexplained pre-existing or generated files may be staged or released.
- Record content-bound verification for the staged release snapshot, then create the conventional release commit and `gedpi-v0.20.0` tag on that exact commit.
- Push the release commit and tag without force, then establish GitHub Actions workflow success, GitHub release presence, and npm publication of exactly 0.20.0. If any remote status cannot be established, stop and report rather than claiming a successful release.

## Constraints and non-goals

- Do not add `exec_command`, `apply_patch`, or any tool alias.
- Do not add another compatibility extension.
- Do not broadly permit npm scripts as read-only.
- Do not weaken unknown-tool snapshot observation.
- Do not use private Plannotator compatibility shims.
- Do not force-push, move an existing tag, publish manually outside the repository's established tag workflow, or release with a failed/unproven gate.
- Do not absorb unrelated working-tree changes.

## Acceptance criteria

- Positive read-only Bash forms pass and adversarial/mutating forms remain blocked in focused tests.
- `@howaboua/pi-codex-conversion` is absent from source configuration, lock resolution, installed dependency graph, and packed output.
- `@plannotator/pi-extension` remains configured and packaged; this plan receives a real visual approval before acceptance; deterministic tests enforce the strongest safe ordering/binding supported by public APIs.
- Native tools remain available and unknown mutation-capable tools remain snapshot-observed.
- Formatting, type-checking, lint, focused tests, full verification, high-severity audit, pack check, packed-tarball installation/loading, and `git diff --check` all pass.
- The staged snapshot is explained and content-bound verified before commit.
- The tag identifies the verified release commit; non-force push succeeds; workflow, GitHub release, and npm 0.20.0 publication are all confirmed.

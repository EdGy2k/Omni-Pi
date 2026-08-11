# TESTS: GedPi 0.20.0 native-tool governance and release

## Plan and governance evidence

- Real pre-acceptance `gedpi_plan_review` opens its visual surface for canonical `TASKS.md` and returns explicit approval.
- `ged_governance accept-plan` succeeds only after that decision and binds current `SPEC.md`, `TASKS.md`, and `TESTS.md` bytes.
- Planned source mutation is rejected before acceptance and permitted after current acceptance; changed plan bytes cannot silently reuse accepted-plan evidence.

## Focused automated coverage

Run the exact discovered Vitest files/selectors for:

1. read-only Bash classifier positive cases: `pwd`, bounded `uname`, `git status`, `git rev-parse`, safe `git diff` and `git diff --check`, `git log`, `git show`, `git branch --show-current`;
2. adversarial cases: `;`, `&&`, `||`, pipes, redirects, heredocs, `$()`, backticks, newlines, shell escapes, mutating Git subcommands/options, aliases/config execution, npm scripts, malformed/ambiguous arguments;
3. caller behavior distinguishing audited inspection from governed mutation and snapshot-observing unknown tools;
4. plan-review bridge registration and ordering before acceptance/mutation;
5. package manifest/lock/pack assertions retaining Plannotator and removing Codex conversion/forbidden aliases;
6. isolated read-only, direct-change, and planned-change smoke lifecycle paths.

Acceptance: all focused files/tests pass, with counts reported from Vitest output.

## Required release commands

Run and require zero exit status from:

- `npm run format`
- `npm run check`
- `npm run lint`
- focused Vitest command(s) discovered above
- `npm run verify`
- `npm audit --audit-level=high`
- `npm run pack:check`
- `git diff --check`

Formatting must be followed by status/diff inspection; no gate may be waived because it requires governed work.

## Tarball install/load gate

- Produce the exact 0.20.0 tarball with `npm pack --json` after metadata is final.
- Inspect its file list for expected source/extensions/docs and absence of nested `node_modules`, nested lockfiles, vendored dependency links, secrets, `@howaboua/pi-codex-conversion`, `exec_command`, and `apply_patch` compatibility artifacts.
- In a newly created temporary project, install the tarball with npm under the supported Node version.
- Resolve/read installed `gedpi/package.json`; assert version 0.20.0, native ged-core extension, retained `@plannotator/pi-extension`, and no conversion extension/dependency.
- Launch or import through supported public package/Pi APIs sufficiently to prove package and configured extension loading; assert native `read`, `bash`, `write`, and `edit` plus `gedpi_plan_review` are available. A load failure or missing tool stops release.
- Remove only temporary/generated pack artifacts after preserving command results.

## Exact snapshot and repository checks

- Explain initial and final `git status --short --branch`.
- Review `git diff`, `git diff --cached`, `git diff --check`, changed paths, and package file list.
- Search active configuration/source/tests/docs for removed dependency and forbidden aliases; historical changelog statements may remain only when clearly describing older releases.
- Assert unknown mutation-capable tool tests still produce conservative snapshot-observed mutation evidence.
- Stage only work-scope files and record verification through `ged_governance` using argv-based commands on the exact snapshot.
- After commit, assert commit tree equals the verified staged tree and tag target equals release commit.

## Remote release checks

After a non-force push of the release commit and `gedpi-v0.20.0` tag:

- confirm remote main and tag object/commit identities;
- inspect GitHub Actions `release-gedpi.yml` run for the tag and require successful conclusion;
- confirm the GitHub release for `gedpi-v0.20.0` exists and targets the exact tag;
- query npm registry and require published `gedpi@0.20.0` metadata matching the release.

Any failed or indeterminate check is a release blocker. Report focused/full counts, audit result, pack/install/load evidence, commit/tag/push/workflow/publication status, and residual risks.

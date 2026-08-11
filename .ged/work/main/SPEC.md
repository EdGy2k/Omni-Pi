# Spec: Task-scoped governance kernel — slice 5

## Goal

Replace role-centric runtime guards and prompts with authoritative,
staffing-independent governance transitions.

## Scope

- Resolve work mode from structured mutation, ambiguity, risk, and
  direct-change evidence when `ged_work` opens a task.
- Require an active authoritative governance record when continuing work.
- Add role-neutral runtime transitions for accepted-plan and verification
  evidence; source writes enter durable pending state before execution and
  append implementation evidence only after success.
- Enforce direct/planned/read-only, decision, lifecycle, plan, and verification
  rules independently of subagent settings.
- Remove role checkpoint hard guards, completion authority, and commit
  auto-close from the extension runtime.
- Update system/orchestration prompts and injected status to use governance
  vocabulary and treat staffing as optional capacity.
- Resolve symlinked write/edit targets and protect runtime-owned `.ged` state.

## Non-goals

- Do not add content/Git fingerprints, broad mutation-tool detection, or staged
  diff verification; those belong to plan 002.
- Do not add lifecycle transition commands yet.
- Do not implement adaptive model/profile selection from plan 003.
- Keep legacy checkpoint parsing only as non-authorizing compatibility and
  migration code until later cleanup proves it has no remaining consumers.

## Acceptance

- Governance decisions and guards are identical with subagents enabled or
  disabled.
- Direct-change work can mutate after binding; planned-change source mutation
  requires satisfied plan evidence; unresolved/read-only/non-active work is
  blocked.
- Commits require satisfied verification recorded after the latest
  implementation evidence, regardless of who performed verification.
- Pending writes remain commit-blocking across runtime restart; failed writes
  clear pending state without implementation evidence.
- Subagent completion and legacy checkpoints cannot authorize mutation.
- Successful commits do not close authoritative or legacy work state.
- Prompt/status injection reads governance JSON rather than Markdown or role
  checkpoints as authority.

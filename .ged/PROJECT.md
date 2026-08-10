# Project

## Goal

Provide a batteries-included Pi coding harness whose single user-facing brain
keeps work understandable, safe, recoverable, and efficient while optionally
using specialist agents for extra capacity.

## Users

- Primary users: developers using GedPi to inspect and change repositories.
- Secondary users: project maintainers configuring reusable standards, skills,
  model profiles, and release behavior.

## Constraints

- Technical: Node.js 22.19+, ESM/NodeNext TypeScript, Pi extension APIs,
  filesystem-backed durable memory, and Git repositories/worktrees when present.
- Product: the main brain remains the decision owner; safety cannot depend on
  subagents being available; commits require current evidence; pushes are never
  automatic without explicit user intent.
- Reliability: stale tasks, plans, verification, or child results must not
  authorize current work.

## Success Criteria

- Read-only, direct-change, and planned-change modes apply proportionate
  governance without mandatory role ceremony.
- Adaptive staffing scales from solo work to scouts, workers, smart workers, and
  fresh verification while preserving one writer per worktree.
- Task identity, approval, mutation, verification, lifecycle, and recovery are
  explicit and content-bound.
- Durable memory contains substantive project knowledge rather than generated
  placeholders or task-paraphrase skills.

## Repo Signals

- Detected languages: typescript
- Detected frameworks: unknown
- Detected tools: vitest

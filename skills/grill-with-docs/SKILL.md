---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions. Triggers include "domain", "glossary", "terminology", "ubiquitous language", "CONTEXT.md", "ADR", "architecture decision", "decision record", "context map", "domain model".
---

# grill-with-docs

Use this instead of plain `grill-me` when clarification should also update durable domain language, project context, or ADR-worthy decisions.

Adapted for GedPi from the upstream `mattpocock/skills` `engineering/grill-with-docs` skill, current as of 2026-05-20.

## What to do

Interview the user relentlessly about every aspect of the plan until there is shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer.

Ask questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase or durable Ged memory, inspect those sources instead of asking.

## Domain awareness

During codebase exploration, also look for existing documentation:

- `CONTEXT.md` at the repo root for a single-context repo.
- `CONTEXT-MAP.md` at the repo root for a multi-context repo.
- `docs/adr/` for system-wide ADRs.
- Context-specific `CONTEXT.md` or `docs/adr/` folders near relevant source directories.
- Substantive `.ged/PROJECT.md` facts. Legacy `.ged/GLOSSARY.md` and
  `.ged/DECISIONS.md` are migration pointers only, never writable authorities.

Create files lazily — only when there is something concrete to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with existing language in canonical
`CONTEXT.md`, call it out immediately.

Example: "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term.

Example: "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precision about boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it.

Example: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right away. Don't batch these up.

`CONTEXT.md` should be a glossary, not a spec, scratch pad, or implementation decision log. Keep it devoid of implementation details.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will wonder why it was done this way.
3. **The result of a real trade-off** — there were genuine alternatives and one was picked for specific reasons.

If any condition is missing, skip the ADR.

## CONTEXT.md format

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request
```

Rules:

- Be opinionated: pick the best word and list aliases to avoid.
- Flag conflicts explicitly.
- Keep definitions to one or two sentences.
- Show relationships and cardinality where obvious.
- Include only terms specific to this project's context, not general programming concepts.
- Group terms under subheadings when natural clusters emerge.
- Add a short example dialogue when it clarifies how terms interact.

## ADR format

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc.

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

Optional sections only when genuinely valuable:

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`).
- **Considered Options**.
- **Consequences**.

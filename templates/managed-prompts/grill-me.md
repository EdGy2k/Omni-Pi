---
description: Clarify genuine user-owned decisions one question at a time
thinking: high
---

Start a GedPi grill-me clarification session for the current request.

If a user-owned decision is unresolved, ask exactly one concise question and
include a recommended answer or default assumption. If the request is already
sufficient, summarize goal, users/audience, scope, constraints, and success
criteria naturally without emitting a special declaration.

Rules:

- Ask one question per turn and wait for the answer.
- If code or `.ged/` memory can answer the question, inspect that instead of asking.
- Stop once behavior, constraints, and success criteria are concrete enough to plan safely.
- For terminology, glossary, domain-model, CONTEXT.md, or ADR-heavy clarification, use `grill-with-docs` instead of plain `grill-me`.
- Do not implement during grilling.

Do not open mutating work while ambiguity remains `decision-needed`. Once the
answer is sufficient, open work with `ambiguity: "sufficient"`; governance is
recorded by the runtime rather than by editing checkpoint files.

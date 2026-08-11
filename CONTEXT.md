# GedPi Project Context

GedPi is a Pi coding harness whose coordinator owns user-facing decisions and
uses task-scoped governance independently of optional execution staffing.

## Language

**Work item**:
One explicit user-requested unit of work with a unique work ID, governance
decision, evidence, and lifecycle independent of a Git branch.

**Work mode**:
Governance depth: `read-only`, `direct-change`, or `planned-change`.

**Execution profile**:
Optional team shape: `solo`, `assisted`, `coordinated`, or `high-stakes`.

**Scout**:
Read-only specialist for focused repository or external context.

**Worker**:
Single bounded implementation writer; parallel workers require distinct managed
worktrees.

**Smart Worker**:
Stronger bounded implementation/coordinator profile for hard approved slices;
it does not own user/product decisions.

**Verifier**:
Fresh evidence producer that challenges the diff and checks; process success
alone is not authorization.

**Coordinator**:
The main GedPi brain and sole user-facing decision owner.

**Milestone**:
A verified commit or completed slice within a work item; it is not work
completion.

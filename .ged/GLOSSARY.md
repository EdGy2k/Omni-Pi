# Glossary

- **Work item**: one explicit user-requested unit of work with a unique work ID,
  governance decision, evidence, and lifecycle independent of a Git branch.
- **Work mode**: governance depth: `read-only`, `direct-change`, or
  `planned-change`.
- **Execution profile**: optional team shape: `solo`, `assisted`, `coordinated`,
  or `high-stakes`.
- **Scout**: read-only specialist for focused repository or external context.
- **Worker**: single bounded implementation writer; parallel workers require
  distinct managed worktrees.
- **Smart Worker**: stronger bounded implementation/coordinator profile for hard
  approved slices; it does not own user/product decisions.
- **Verifier**: fresh evidence producer that challenges the diff and checks; its
  process success alone is not authorization.
- **Coordinator**: the main GedPi brain and sole user-facing decision owner.
- **Milestone**: a verified commit or completed slice within a work item; it is
  not the same as work completion.

# SPEC: Update Pi runtime and companion dependencies

## Goal
Update GedPi to the latest published Pi runtime and compatible actively bundled companion extensions.

## Scope
- Update the direct `@earendil-works/*` Pi runtime stack and `@mariozechner/*` compatibility aliases from `0.81.1` to `0.82.1`.
- Update companion packages whose latest releases are compatible with or require Pi 0.82:
  - `@howaboua/pi-codex-conversion` to `2.2.27`
  - `@plannotator/pi-extension` to `0.25.0`
  - `pi-subagents` to `0.37.2`
  - `pi-web-access` to `0.15.0`
- Preserve already-current companion dependencies.
- Refresh the lockfile, fix compatibility issues, update dependency assertions and changelog, and verify packaging.

## Sufficiency
The user clarified that the requested update targets the Pi agent and required dependencies. npm metadata establishes the latest versions and peer compatibility requirements, so no further product decision is needed.

## Skill fit
Bundled `ged-planning`, `ged-execution`, and `verify` cover this work. No additional skill is required.

/**
 * Shared checkpoint state types and validation for GedOC and GedPi.
 *
 * Both packages use the same .ged/runtime/<work-id>/checkpoints.json schema
 * to ensure the .ged/ memory format stays interchangeable.
 *
 * Schema v2 adds: source provenance, clarification evidence, explorer-first
 * enforcement, planner outcome tracking, and blocked/failed statuses.
 * Schema v3 adds: task lifecycle status so completed tasks cannot authorize
 * later guarded tool use on the same branch, main-agent plan acceptance, and
 * non-authorizing worker run audit metadata.
 */

// ─── JSDoc type definitions ─────────────────────────────────────────────

/**
 * @typedef {"trivial" | "non-trivial"} TaskClassification
 */

/**
 * @typedef {"ged-explorer" | "ged-planner" | "ged-plan-reviewer" | "ged-verifier" | "ged-worker"} CheckpointAgent
 */

/**
 * @typedef {"ged-explorer" | "ged-planner" | "ged-plan-reviewer"} PlanCheckpointAgent
 */

/**
 * @typedef {"ged-explorer" | "ged-verifier" | "ged-worker"} TaskCheckpointAgent
 */

/**
 * @typedef {"auto" | "manual" | "fallback"} CheckpointSource
 */

/**
 * @typedef {"completed" | "skipped" | "blocked" | "failed"} CheckpointStatus
 */

/**
 * @typedef {"active" | "verified" | "closed"} CheckpointLifecycleStatus
 */

/**
 * @typedef {"planned" | "refused-needs-clarification"} PlannerOutcome
 */

/**
 * @typedef {Object} CheckpointRecord
 * @property {CheckpointAgent} agent
 * @property {string} timestamp
 * @property {CheckpointStatus} status
 * @property {CheckpointSource} [source]
 * @property {string} [skipReason]
 * @property {PlannerOutcome} [outcome]
 * @property {number} [findingCount]
 * @property {boolean} [blocksCommit]
 * @property {"clean"} [verifierOutcome]
 * @property {string} [acceptanceStatus]
 * @property {string} [runId]
 * @property {string} [sliceId]
 * @property {string} [artifactPath]
 * @property {Record<string, unknown>} [artifactPaths]
 * @property {string} [diffPath]
 * @property {string} [sessionPath]
 * @property {string} [worktreePath]
 * @property {boolean} [worktree]
 * @property {"foreground" | "async" | "fallback"} [sourceMode]
 */

/**
 * @typedef {Object} PlanAcceptanceRecord
 * @property {"accepted"} status
 * @property {"manual" | "fallback"} source
 * @property {string} timestamp
 * @property {string[]} planPaths
 * @property {string} [summary]
 * @property {string} [skipReason]
 */

/**
 * @typedef {Object} WorkerRunRecord
 * @property {"ged-worker"} agent
 * @property {string} timestamp
 * @property {CheckpointStatus} status
 * @property {CheckpointSource} [source]
 * @property {string} [runId]
 * @property {string} [taskId]
 * @property {string} [sliceId]
 * @property {string} [artifactPath]
 * @property {Record<string, unknown>} [artifactPaths]
 * @property {string} [diffPath]
 * @property {string} [sessionPath]
 * @property {string} [worktreePath]
 * @property {boolean} [worktree]
 * @property {"foreground" | "async" | "fallback"} [sourceMode]
 */

/**
 * @typedef {Object} ClarificationEvidence
 * @property {string} goal
 * @property {string} users
 * @property {string} scope
 * @property {string} constraints
 */

/**
 * @typedef {Object} ClarificationRecord
 * @property {"completed" | "skipped"} status
 * @property {"manual"} source
 * @property {string} timestamp
 * @property {ClarificationEvidence} [evidence]
 * @property {"sufficient-from-request"} [sufficiency]
 * @property {string} [skipReason]
 */

/**
 * @typedef {Object} CheckpointState
 * @property {number} schemaVersion
 * @property {CheckpointLifecycleStatus} lifecycleStatus
 * @property {TaskClassification} classification
 * @property {string} classificationReason
 * @property {ClarificationRecord} [clarification]
 * @property {PlanAcceptanceRecord} [planAcceptance]
 * @property {Partial<Record<PlanCheckpointAgent, CheckpointRecord>>} planCheckpoints
 * @property {Record<string, Partial<Record<TaskCheckpointAgent, CheckpointRecord>>>} taskCheckpoints
 * @property {WorkerRunRecord[]} [workerRuns]
 */

/**
 * @typedef {Object} CheckpointValidation
 * @property {boolean} valid
 * @property {string[]} missing
 * @property {string} [warning]
 */

// ─── Schema version ─────────────────────────────────────────────────────

const CURRENT_SCHEMA_VERSION = 3;
const MIN_SUPPORTED_SCHEMA_VERSION = 2;
const CLOSED_CHECKPOINT_MISSING = "checkpoint lifecycle closed";

// ─── Initializers ───────────────────────────────────────────────────────

/**
 * @param {TaskClassification} classification
 * @param {string} classificationReason
 * @returns {CheckpointState}
 */
export function initCheckpointState(classification, classificationReason) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lifecycleStatus: "active",
    classification,
    classificationReason,
    planCheckpoints: {},
    taskCheckpoints: {},
  };
}

// ─── Schema version check ───────────────────────────────────────────────

/**
 * Check the schema version of raw checkpoint JSON. Returns status with
 * a migration message for legacy/corrupt files.
 * @param {unknown} raw
 * @returns {{ ok: boolean, version: number | null, error: string | null }}
 */
export function checkSchemaVersion(raw) {
  if (typeof raw !== "string") {
    return { ok: true, version: null, error: null };
  }
  try {
    const parsed = JSON.parse(raw);
    const version =
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null;

    if (version === null || version < MIN_SUPPORTED_SCHEMA_VERSION) {
      return {
        ok: false,
        version,
        error:
          "Checkpoint file uses legacy schema v1. Re-run task classification to create a v2 checkpoint. Existing planner/verifier checkpoints cannot be trusted and must be regenerated. Write a new classification to .ged/runtime/<work-id>/checkpoints.json.",
      };
    }
    if (version > CURRENT_SCHEMA_VERSION) {
      return {
        ok: false,
        version,
        error: `Checkpoint file uses unknown schema v${version}. Update GedPi/GedOC to a version that supports this schema.`,
      };
    }
    return { ok: true, version: CURRENT_SCHEMA_VERSION, error: null };
  } catch {
    return {
      ok: false,
      version: null,
      error:
        "Checkpoint file is corrupt (invalid JSON). Delete it and re-classify the task.",
    };
  }
}

// ─── Validation helpers ─────────────────────────────────────────────────

/**
 * Check whether a string is a non-placeholder value.
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {boolean}
 */
function isValidEvidenceField(value, fieldName) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  // Reject obvious placeholders
  if (["n/a", "unknown", "todo", "tbd", "none", "...", "-"].includes(lower)) {
    return false;
  }
  // Reject single-word answers that are too short to be meaningful
  if (
    fieldName !== "goal" &&
    trimmed.split(/\s+/u).length < 2 &&
    trimmed.length < 20
  ) {
    return false;
  }
  return true;
}

/**
 * Validate a checkpoint record has auto provenance and is complete.
 * @param {CheckpointRecord | undefined} record
 * @param {"completed" | undefined} [requiredStatus]
 * @returns {{ valid: boolean, reason: string }}
 */
function hasFallbackReason(record) {
  return (
    typeof record?.skipReason === "string" &&
    record.skipReason.trim().length > 0
  );
}

/**
 * Validate a checkpoint record has auto provenance, or an explicit fallback
 * provenance with a reason when the role is disabled and the main agent took
 * responsibility.
 * @param {CheckpointRecord | undefined} record
 * @param {"completed" | undefined} [requiredStatus]
 * @param {{ allowFallbackSkipped?: boolean }} [options]
 * @returns {{ valid: boolean, reason: string }}
 */
function isValidAutoOrFallbackRecord(record, requiredStatus, options = {}) {
  if (!record) return { valid: false, reason: "missing" };
  if (record.source === "fallback") {
    if (!hasFallbackReason(record)) {
      return { valid: false, reason: "fallback without reason" };
    }
    if (
      requiredStatus &&
      record.status !== requiredStatus &&
      !(options.allowFallbackSkipped && record.status === "skipped")
    ) {
      return {
        valid: false,
        reason: `status is ${record.status}, not ${requiredStatus}`,
      };
    }
    return { valid: true, reason: "" };
  }
  if (record.source !== "auto") {
    return { valid: false, reason: "not auto-recorded or fallback" };
  }
  if (requiredStatus && record.status !== requiredStatus)
    return {
      valid: false,
      reason: `status is ${record.status}, not ${requiredStatus}`,
    };
  return { valid: true, reason: "" };
}

/**
 * Test if a clarifying bit of evidence is fully valid.
 * @param {Record<string, string> | undefined} evidence
 * @returns {CheckpointValidation}
 */
function validateClarificationEvidence(evidence) {
  const missing = [];
  if (!evidence || typeof evidence !== "object") {
    return { valid: false, missing: ["clarification.evidence"] };
  }
  for (const field of ["goal", "users", "scope", "constraints"]) {
    if (!isValidEvidenceField(evidence[field], field)) {
      missing.push(`clarification.evidence.${field}`);
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Validate that the main agent accepted/wrote the final plan artifacts after
 * planner draft/fallback. This is deliberately separate from human plan-review
 * approval and from ged-planner completion.
 * @param {PlanAcceptanceRecord | undefined} record
 * @param {CheckpointRecord | undefined} plannerRecord
 * @returns {CheckpointValidation}
 */
function validatePlanAcceptance(record, plannerRecord) {
  const missing = [];
  if (!record || typeof record !== "object") {
    return { valid: false, missing: ["planAcceptance"] };
  }
  if (record.status !== "accepted") missing.push("planAcceptance.status");
  if (record.source !== "manual" && record.source !== "fallback") {
    missing.push("planAcceptance.source");
  }
  const acceptanceTime = Date.parse(record.timestamp);
  if (
    typeof record.timestamp !== "string" ||
    record.timestamp.trim() === "" ||
    Number.isNaN(acceptanceTime)
  ) {
    missing.push("planAcceptance.timestamp");
  }
  const planPaths = Array.isArray(record.planPaths)
    ? record.planPaths.filter(
        (item) => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  if (planPaths.length === 0) missing.push("planAcceptance.planPaths");
  if (
    record.source === "fallback" &&
    !(typeof record.skipReason === "string" && record.skipReason.trim()) &&
    !(typeof record.summary === "string" && record.summary.trim())
  ) {
    missing.push("planAcceptance.fallbackReason");
  }
  if (plannerRecord?.timestamp) {
    const plannerTime = Date.parse(plannerRecord.timestamp);
    if (Number.isNaN(plannerTime)) {
      missing.push("ged-planner.timestamp");
    } else if (!Number.isNaN(acceptanceTime) && acceptanceTime < plannerTime) {
      missing.push("planAcceptance.afterPlanner");
    }
  }
  return { valid: missing.length === 0, missing };
}

// ─── Parse / Validate ───────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {value is CheckpointState}
 */
function isValidCheckpointState(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = /** @type {Record<string, unknown>} */ (value);
  const lifecycleStatus = obj.lifecycleStatus ?? "active";
  return (
    typeof obj.schemaVersion === "number" &&
    obj.schemaVersion >= MIN_SUPPORTED_SCHEMA_VERSION &&
    obj.schemaVersion <= CURRENT_SCHEMA_VERSION &&
    (lifecycleStatus === "active" ||
      lifecycleStatus === "verified" ||
      lifecycleStatus === "closed") &&
    (obj.classification === "trivial" ||
      obj.classification === "non-trivial") &&
    typeof obj.classificationReason === "string" &&
    typeof obj.planCheckpoints === "object" &&
    obj.planCheckpoints !== null &&
    typeof obj.taskCheckpoints === "object" &&
    obj.taskCheckpoints !== null &&
    (obj.workerRuns === undefined || Array.isArray(obj.workerRuns))
  );
}

/**
 * Parse and validate raw checkpoint state. Returns null if missing or invalid.
 * Legacy v1 files return null — checkSchemaVersion gives the migration message.
 * @param {unknown} raw
 * @returns {CheckpointState | null}
 */
export function parseCheckpointState(raw) {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isValidCheckpointState(parsed)) return null;
    return {
      ...parsed,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lifecycleStatus: parsed.lifecycleStatus ?? "active",
    };
  } catch {
    return null;
  }
}

/**
 * Check whether the planner checkpoint exists for non-trivial work.
 * v2 requirements: clarification completed + explorer (auto, completed or skipped)
 * + planner (auto, completed, not explicitly refused). Trivial work skips all checks.
 * Returns valid=false for null state (classification is required before edits).
 * @param {CheckpointState | null} state
 * @returns {CheckpointValidation}
 */
export function validatePlannerCheckpoint(state) {
  if (!state) {
    return {
      valid: false,
      missing: ["classification"],
      warning:
        "No checkpoint state found — classify the task and write .ged/runtime/<work-id>/checkpoints.json before inspecting or editing source files.",
    };
  }
  if (isCheckpointClosed(state)) {
    return {
      valid: false,
      missing: [CLOSED_CHECKPOINT_MISSING],
      warning:
        "Previous task is closed; classify the current task before using guarded tools.",
    };
  }
  if (state.classification === "trivial") {
    return { valid: true, missing: [] };
  }

  const missing = [];

  // 1. Clarification must be completed with evidence or explicitly skipped as sufficient.
  if (!state.clarification) {
    missing.push("clarification");
  } else if (state.clarification.status === "completed") {
    const evidenceCheck = validateClarificationEvidence(
      state.clarification.evidence,
    );
    missing.push(...evidenceCheck.missing);
  } else if (state.clarification.status === "skipped") {
    if (state.clarification.sufficiency !== "sufficient-from-request") {
      missing.push("clarification.sufficiency");
    }
    if (
      typeof state.clarification.skipReason !== "string" ||
      state.clarification.skipReason.trim().length === 0
    ) {
      missing.push("clarification.skipReason");
    }
  } else {
    missing.push("clarification");
  }

  // 2. Explorer must have run with auto provenance (completed or skipped with reason)
  const explorerRecord = state.planCheckpoints["ged-explorer"];
  if (!explorerRecord) {
    missing.push("ged-explorer (auto-recorded)");
  } else {
    const explorerCheck = isValidAutoOrFallbackRecord(
      explorerRecord,
      undefined,
    );
    if (!explorerCheck.valid) {
      missing.push(`ged-explorer (${explorerCheck.reason})`);
    } else if (
      explorerRecord.status !== "completed" &&
      explorerRecord.status !== "skipped"
    ) {
      missing.push(
        `ged-explorer (status: ${explorerRecord.status}, not completed or skipped)`,
      );
    } else if (
      explorerRecord.status === "skipped" &&
      (!explorerRecord.skipReason ||
        explorerRecord.skipReason.trim().length === 0)
    ) {
      missing.push("ged-explorer (skipped without reason)");
    }
  }

  // 3. Planner must have run with auto provenance and completed.
  // Missing outcome remains valid for backward compatibility, but an explicit
  // refusal means the main agent must run grill-me and re-dispatch planner.
  const plannerRecord = state.planCheckpoints["ged-planner"];
  if (!plannerRecord) {
    missing.push("ged-planner (auto-recorded)");
  } else {
    const plannerCheck = isValidAutoOrFallbackRecord(
      plannerRecord,
      "completed",
      { allowFallbackSkipped: true },
    );
    if (!plannerCheck.valid) {
      missing.push(`ged-planner (${plannerCheck.reason})`);
    } else if (plannerRecord.outcome === "refused-needs-clarification") {
      missing.push("ged-planner (outcome: refused-needs-clarification)");
    }
  }

  // 4. Main agent must accept/write final plan artifacts after planner draft or fallback.
  const acceptanceCheck = validatePlanAcceptance(
    state.planAcceptance,
    plannerRecord,
  );
  missing.push(...acceptanceCheck.missing);

  return { valid: missing.length === 0, missing };
}

/**
 * Check whether the verifier checkpoint exists for a specific task slice.
 * Returns valid=false for null state (classification is required before commits).
 * Returns valid=true for trivial classification (no verifier needed).
 * @param {CheckpointState | null} state
 * @param {string} taskId
 * @returns {CheckpointValidation}
 */
export function validateVerifierCheckpoint(state, taskId) {
  if (!state) {
    return {
      valid: false,
      missing: ["classification"],
      warning:
        "No checkpoint state found — classify the task and write .ged/runtime/<work-id>/checkpoints.json before committing.",
    };
  }
  if (isCheckpointClosed(state)) {
    return {
      valid: false,
      missing: [CLOSED_CHECKPOINT_MISSING],
      warning:
        "Previous task is closed; classify the current task before using guarded tools.",
    };
  }
  if (state.classification === "trivial") {
    return { valid: true, missing: [] };
  }
  const missing = [];
  const verifierRecord = state.taskCheckpoints[taskId]?.["ged-verifier"];
  if (!verifierRecord) {
    missing.push("ged-verifier");
  } else {
    const check = isValidAutoOrFallbackRecord(verifierRecord, "completed");
    if (!check.valid) {
      missing.push(`ged-verifier (${check.reason})`);
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Check verifier checkpoints for ALL task slices that have any checkpoint data.
 * v2 addition: also validates source provenance on verifier records.
 * @param {CheckpointState | null} state
 * @returns {CheckpointValidation}
 */
export function validateAllVerifierCheckpoints(state) {
  if (!state) {
    return {
      valid: false,
      missing: ["classification"],
      warning:
        "No checkpoint state found — classify the task and write .ged/runtime/<work-id>/checkpoints.json before committing.",
    };
  }
  if (isCheckpointClosed(state)) {
    return {
      valid: false,
      missing: [CLOSED_CHECKPOINT_MISSING],
      warning:
        "Previous task is closed; classify the current task before using guarded tools.",
    };
  }
  if (state.classification === "trivial") {
    return { valid: true, missing: [] };
  }
  const missing = [];
  let sawVerifier = false;
  for (const [taskId, checkpoints] of Object.entries(state.taskCheckpoints)) {
    const verifier = checkpoints?.["ged-verifier"];
    if (!verifier) {
      missing.push(`ged-verifier (task ${taskId})`);
      continue;
    }
    sawVerifier = true;
    const check = isValidAutoOrFallbackRecord(verifier, "completed");
    if (!check.valid) {
      missing.push(`ged-verifier (task ${taskId}: ${check.reason})`);
    } else if (verifier.blocksCommit) {
      missing.push(`ged-verifier blocked commit (task ${taskId})`);
    }
  }
  if (!sawVerifier) {
    missing.push("ged-verifier (auto-recorded)");
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Validate whether it is safe to create or amend a git commit.
 * v2: planner and verifier must have auto provenance.
 * @param {CheckpointState | null} state
 * @returns {CheckpointValidation}
 */
export function validateCommitCheckpoints(state) {
  if (!state) {
    return {
      valid: false,
      missing: ["classification"],
      warning:
        "No checkpoint state found — classify the task and write .ged/runtime/<work-id>/checkpoints.json before committing.",
    };
  }
  if (isCheckpointClosed(state)) {
    return {
      valid: false,
      missing: [CLOSED_CHECKPOINT_MISSING],
      warning:
        "Previous task is closed; classify the current task before using guarded tools.",
    };
  }
  if (state.classification === "trivial") {
    return { valid: true, missing: [] };
  }

  const missing = [];

  // Planner validation (includes clarification + explorer + planner)
  const plannerValidation = validatePlannerCheckpoint(state);
  missing.push(...plannerValidation.missing);

  // Verifier validation
  const verifierValidation = validateAllVerifierCheckpoints(state);
  missing.push(...verifierValidation.missing);

  return { valid: missing.length === 0, missing };
}

// ─── Source inspection guard ─────────────────────────────────────────────

/**
 * Check whether the explorer checkpoint allows source file inspection.
 * Returns true if the task is trivial or an auto-recorded explorer has run.
 * Used by the tool-call guard to block premature source reads for non-trivial work.
 * @param {CheckpointState | null} state
 * @returns {boolean}
 */
export function hasExplorerClearedInspection(state) {
  if (!state) return false;
  if (isCheckpointClosed(state)) return false;
  if (state.classification === "trivial") return true;
  const explorerRecord = state.planCheckpoints["ged-explorer"];
  if (!explorerRecord) return false;
  const check = isValidAutoOrFallbackRecord(explorerRecord, undefined);
  if (!check.valid) return false;
  return (
    explorerRecord.status === "completed" ||
    (explorerRecord.status === "skipped" &&
      !!explorerRecord.skipReason &&
      explorerRecord.skipReason.trim().length > 0)
  );
}

/**
 * Determine whether a file path is safe to read before explorer runs.
 * Only .md files and .ged/ directory files are allowed as pre-explorer reads
 * (so the agent can bootstrap from Ged memory).
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSafePreExplorerRead(filePath) {
  const normalized = filePath.replace(/\\/gu, "/");
  return (
    normalized.endsWith(".md") ||
    normalized.includes("/.ged/") ||
    normalized.startsWith(".ged/")
  );
}

// ─── Mutation ───────────────────────────────────────────────────────────

/**
 * Record a checkpoint in the state. Returns a new state object.
 * Does NOT stamp source:"auto" — use recordAutoCheckpoint for that.
 * If taskId is provided, records under taskCheckpoints; otherwise planCheckpoints.
 * Merges carefully: a completed entry is not overwritten by a skipped one.
 * @param {CheckpointState} state
 * @param {CheckpointRecord} record
 * @param {string} [taskId]
 * @returns {CheckpointState}
 */
export function recordCheckpoint(state, record, taskId) {
  if (isCheckpointClosed(state)) return state;
  const withWorkerRun = (next) => {
    if (record.agent !== "ged-worker") return next;
    return invalidateVerifierCheckpoints(
      recordWorkerRun(next, { taskId, ...record }),
    );
  };
  if (taskId) {
    return withWorkerRun({
      ...state,
      taskCheckpoints: {
        ...state.taskCheckpoints,
        [taskId]: {
          ...state.taskCheckpoints[taskId],
          [record.agent]: record,
        },
      },
    });
  }

  return withWorkerRun({
    ...state,
    planCheckpoints: {
      ...state.planCheckpoints,
      [record.agent]: record,
    },
  });
}

/**
 * Record a checkpoint with auto provenance. Only callable from the
 * auto-recording hooks that detect real subagent dispatch events.
 * Stamps source:"auto" on the record.
 * @param {CheckpointState} state
 * @param {CheckpointRecord} record
 * @param {string} [taskId]
 * @returns {CheckpointState}
 */
export function recordAutoCheckpoint(state, record, taskId) {
  return recordCheckpoint(state, { ...record, source: "auto" }, taskId);
}

/**
 * Record main-agent acceptance of final plan artifacts.
 * @param {CheckpointState} state
 * @param {PlanAcceptanceRecord} record
 * @returns {CheckpointState}
 */
export function recordPlanAcceptance(state, record) {
  if (isCheckpointClosed(state)) return state;
  return { ...state, planAcceptance: record };
}

/**
 * Append a non-authorizing worker run audit record.
 * @param {CheckpointState} state
 * @param {Partial<WorkerRunRecord> & { timestamp: string, status: CheckpointStatus }} run
 * @returns {CheckpointState}
 */
export function recordWorkerRun(state, run) {
  if (isCheckpointClosed(state)) return state;
  const existingRuns = Array.isArray(state.workerRuns) ? state.workerRuns : [];
  if (
    run.runId &&
    existingRuns.some(
      (existing) => existing.runId && existing.runId === run.runId,
    )
  ) {
    return state;
  }
  return {
    ...state,
    workerRuns: [...existingRuns, { ...run, agent: "ged-worker" }],
  };
}

/**
 * Consume the planner checkpoint so the next source edit requires fresh planning.
 * Should be called after a commit succeeds, or in the commit guard before
 * allowing the commit through. If the commit fails, the agent must re-plan.
 * @param {CheckpointState} state
 * @returns {CheckpointState}
 */
export function consumePlannerCheckpoint(state) {
  const next = {
    ...state,
    planCheckpoints: {},
  };
  delete next.planAcceptance;
  return next;
}

/**
 * @param {CheckpointState | null} state
 * @returns {boolean}
 */
export function isCheckpointClosed(state) {
  return state?.lifecycleStatus === "closed";
}

/**
 * Mark the current task as verified and ready for commit.
 * @param {CheckpointState} state
 * @returns {CheckpointState}
 */
export function markCheckpointVerified(state) {
  if (isCheckpointClosed(state)) return state;
  return { ...state, lifecycleStatus: "verified" };
}

/**
 * Close the checkpoint after the task is committed/done.
 * @param {CheckpointState} state
 * @returns {CheckpointState}
 */
export function closeCheckpointState(state) {
  return { ...state, lifecycleStatus: "closed" };
}

/**
 * Invalidate all verifier checkpoints by setting blocksCommit: true.
 * This should be called whenever source files are edited after a verifier run,
 * forcing re-verification before the next commit.
 * @param {CheckpointState} state
 * @returns {CheckpointState}
 */
export function invalidateVerifierCheckpoints(state) {
  const nextTaskCheckpoints = { ...state.taskCheckpoints };
  for (const [taskId, checkpoints] of Object.entries(nextTaskCheckpoints)) {
    const verifier = checkpoints?.["ged-verifier"];
    if (verifier) {
      nextTaskCheckpoints[taskId] = {
        ...checkpoints,
        "ged-verifier": {
          ...verifier,
          blocksCommit: true,
        },
      };
    }
  }
  return {
    ...state,
    lifecycleStatus: isCheckpointClosed(state) ? "closed" : "active",
    taskCheckpoints: nextTaskCheckpoints,
  };
}

// ─── Git commit detection ───────────────────────────────────────────────

/**
 * Detect whether a bash command contains `git commit`.
 * Handles bypass vectors: prefixed env/rtk/sudo, nested shells, -C flag, chained commands.
 * @param {string} command
 * @returns {boolean}
 */
export function isGitCommitCommand(command) {
  return containsGitCommitCommand(command, 0);
}

/**
 * @param {string} command
 * @param {number} depth
 * @returns {boolean}
 */
function containsGitCommitCommand(command, depth) {
  if (depth > 3) return false;
  const normalized = command.replace(/\\\n/gu, " ").trim();
  const stripped = normalized
    .replace(/^(?:rtk\s+)?(?:env\s+(?:-[^\s]*\s+)*\s*)?(?:sudo\s+)?/u, "")
    .trim();

  const gitPattern = /(?:^|[|&;]\s*)git(?:\.(?:exe|cmd))?\b.*\bcommit\b/u;
  if (gitPattern.test(stripped)) return true;

  const shellPattern =
    /(?:^|[|&;]\s*)(?:rtk\s+)?(?:env\s+(?:-[^\s]*\s+)*\s*)?(?:sudo\s+)?(?:bash|sh|zsh|fish)\s+(?:-[^\s]*\s+)*(?:-[^\s]*c[^\s]*|-c)\s+(["'])(.*?)\1/gu;
  for (const match of stripped.matchAll(shellPattern)) {
    if (containsGitCommitCommand(match[2], depth + 1)) return true;
  }
  return false;
}

/**
 * Check whether the command contains a skip-checkpoint marker.
 * Only effective when allowCheckpointBypass is true in settings.
 * @param {string} command
 * @returns {boolean}
 */
export function hasSkipCheckpointMarker(command) {
  return /\[skip-checkpoint\]/u.test(command);
}

/**
 * Determine if the work should be auto-escalated to non-trivial based on
 * the number of distinct source file paths being touched.
 * @param {TaskClassification} currentClassification
 * @param {string[]} touchedFilePaths
 * @returns {boolean}
 */
export function shouldAutoEscalate(currentClassification, touchedFilePaths) {
  if (currentClassification === "non-trivial") return false;
  const sourceFiles = touchedFilePaths.filter(
    (p) =>
      !p.includes("/.ged/") &&
      !p.includes("\\.ged\\") &&
      !p.startsWith(".ged/") &&
      !p.startsWith(".ged\\"),
  );
  return sourceFiles.length > 1;
}

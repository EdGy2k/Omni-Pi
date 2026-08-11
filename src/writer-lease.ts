import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic.js";
import {
  isRepositorySnapshot,
  type RepositorySnapshot,
} from "./content-fingerprint.js";

const WRITER_LEASE_VERSION = 1 as const;
const TERMINAL_RUN_STATES = new Set([
  "complete",
  "failed",
  "stopped",
  "rejected",
]);

export interface CheckoutWriterLease {
  version: typeof WRITER_LEASE_VERSION;
  id: string;
  checkoutRoot: string;
  ownerPid: number;
  sessionId: string;
  requestId: string;
  toolCallId: string;
  workId: string;
  pendingMutationId: string;
  beforeSnapshot: RepositorySnapshot;
  phase: "launching" | "active";
  createdAt: string;
  runId?: string;
  asyncDir?: string;
}

interface AcquireWriterLeaseInput {
  sessionId: string;
  requestId: string;
  toolCallId: string;
  workId: string;
  pendingMutationId: string;
  beforeSnapshot: RepositorySnapshot;
}

function runtimeDir(checkoutRoot: string): string {
  return path.join(checkoutRoot, ".ged", "runtime");
}

function leaseDir(checkoutRoot: string): string {
  return path.join(runtimeDir(checkoutRoot), "checkout-writer-lease");
}

function leasePath(checkoutRoot: string): string {
  return path.join(leaseDir(checkoutRoot), "lease.json");
}

function leaseGuardDir(checkoutRoot: string): string {
  return path.join(runtimeDir(checkoutRoot), "checkout-writer-guard");
}

async function withLeaseGuard<T>(
  checkoutRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(runtimeDir(checkoutRoot), { recursive: true });
  try {
    await mkdir(leaseGuardDir(checkoutRoot));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new Error(
        "Ged staffing guard: another checkout writer lease operation is in progress or was interrupted; remaining fail-closed.",
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(leaseGuardDir(checkoutRoot), { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseWriterLease(value: unknown): CheckoutWriterLease {
  if (!isRecord(value)) throw new Error("writer lease must be an object");
  const keys = Object.keys(value).sort();
  const expected = [
    "beforeSnapshot",
    "checkoutRoot",
    "createdAt",
    "id",
    "ownerPid",
    "pendingMutationId",
    "phase",
    "requestId",
    "sessionId",
    "toolCallId",
    "version",
    "workId",
    ...(value.phase === "active" ? ["asyncDir", "runId"] : []),
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error("writer lease has unknown or missing fields");
  }
  if (
    value.version !== WRITER_LEASE_VERSION ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.checkoutRoot !== "string" ||
    !path.isAbsolute(value.checkoutRoot) ||
    typeof value.ownerPid !== "number" ||
    !Number.isInteger(value.ownerPid) ||
    value.ownerPid <= 0 ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    typeof value.requestId !== "string" ||
    !value.requestId ||
    typeof value.toolCallId !== "string" ||
    !value.toolCallId ||
    typeof value.workId !== "string" ||
    !value.workId ||
    typeof value.pendingMutationId !== "string" ||
    !value.pendingMutationId ||
    !isRepositorySnapshot(value.beforeSnapshot) ||
    (value.phase !== "launching" && value.phase !== "active") ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    (value.phase === "active" &&
      (typeof value.runId !== "string" ||
        !value.runId ||
        typeof value.asyncDir !== "string" ||
        !path.isAbsolute(value.asyncDir)))
  ) {
    throw new Error("writer lease has an invalid shape");
  }
  return value as unknown as CheckoutWriterLease;
}

async function readWriterLease(
  checkoutRoot: string,
): Promise<CheckoutWriterLease> {
  try {
    const lease = parseWriterLease(
      JSON.parse(await readFile(leasePath(checkoutRoot), "utf8")) as unknown,
    );
    if (lease.checkoutRoot !== checkoutRoot) {
      throw new Error("writer lease checkout root does not match its location");
    }
    return lease;
  } catch (error) {
    throw new Error(
      `Ged writer lease is unreadable and remains fail-closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function activeRunIsTerminal(
  lease: CheckoutWriterLease,
): Promise<boolean> {
  if (lease.phase !== "active" || !lease.asyncDir) return false;
  try {
    const parsed = JSON.parse(
      await readFile(path.join(lease.asyncDir, "status.json"), "utf8"),
    ) as unknown;
    return (
      isRecord(parsed) &&
      parsed.runId === lease.runId &&
      typeof parsed.state === "string" &&
      TERMINAL_RUN_STATES.has(parsed.state)
    );
  } catch {
    return false;
  }
}

export async function acquireCheckoutWriterLease(
  rootDir: string,
  input: AcquireWriterLeaseInput,
): Promise<CheckoutWriterLease> {
  const checkoutRoot = await realpath(rootDir);
  return withLeaseGuard(checkoutRoot, async () => {
    const id = `writer-${randomUUID()}`;
    try {
      await mkdir(leaseDir(checkoutRoot));
      const lease: CheckoutWriterLease = {
        version: WRITER_LEASE_VERSION,
        id,
        checkoutRoot,
        ownerPid: process.pid,
        sessionId: input.sessionId,
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        workId: input.workId,
        pendingMutationId: input.pendingMutationId,
        beforeSnapshot: input.beforeSnapshot,
        phase: "launching",
        createdAt: new Date().toISOString(),
      };
      await writeFileAtomic(
        leasePath(checkoutRoot),
        `${JSON.stringify(lease, null, 2)}\n`,
      );
      return lease;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        await rm(leaseDir(checkoutRoot), { recursive: true, force: true });
        throw error;
      }
      const existing = await readWriterLease(checkoutRoot);
      const terminal = await activeRunIsTerminal(existing);
      throw new Error(
        `Ged staffing guard: checkout writer lease ${existing.id} is ${existing.phase}${existing.runId ? ` for run ${existing.runId}` : ""}${terminal ? " and awaits mutation-evidence reconciliation" : ""}. Wait for exact completion or recover its pi-subagents status before launching another writer.`,
      );
    }
  });
}

export async function activateCheckoutWriterLease(
  rootDir: string,
  leaseId: string,
  runId: string,
  asyncDir: string,
): Promise<CheckoutWriterLease> {
  const checkoutRoot = await realpath(rootDir);
  return withLeaseGuard(checkoutRoot, async () => {
    const current = await readWriterLease(checkoutRoot);
    if (current.id !== leaseId) {
      throw new Error(`Checkout writer lease changed from ${leaseId}.`);
    }
    if (!runId || !path.isAbsolute(asyncDir)) {
      throw new Error(
        "Active writer lease requires runId and absolute asyncDir.",
      );
    }
    const next: CheckoutWriterLease = {
      ...current,
      phase: "active",
      runId,
      asyncDir: path.resolve(asyncDir),
    };
    await writeFileAtomic(
      leasePath(checkoutRoot),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return next;
  });
}

export async function terminalCheckoutWriterLease(
  rootDir: string,
): Promise<CheckoutWriterLease | null> {
  const checkoutRoot = await realpath(rootDir);
  return withLeaseGuard(checkoutRoot, async () => {
    let lease: CheckoutWriterLease;
    try {
      lease = await readWriterLease(checkoutRoot);
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        return null;
      }
      throw error;
    }
    return (await activeRunIsTerminal(lease)) ? lease : null;
  });
}

export async function releaseCheckoutWriterLease(
  rootDir: string,
  leaseId: string,
): Promise<void> {
  const checkoutRoot = await realpath(rootDir);
  await withLeaseGuard(checkoutRoot, async () => {
    const current = await readWriterLease(checkoutRoot);
    if (current.id !== leaseId) {
      throw new Error(
        `Refusing to release replacement writer lease ${current.id}.`,
      );
    }
    await rm(leaseDir(checkoutRoot), { recursive: true, force: false });
  });
}

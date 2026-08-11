import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { captureRepositorySnapshot } from "../src/content-fingerprint.js";
import {
  acquireCheckoutWriterLease,
  activateCheckoutWriterLease,
  releaseCheckoutWriterLease,
  terminalCheckoutWriterLease,
} from "../src/writer-lease.js";

describe("checkout writer lease", () => {
  test("blocks independent owners and reconciles proven terminal async runs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-writer-root-"));
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    const beforeSnapshot = await captureRepositorySnapshot(rootDir);
    const first = await acquireCheckoutWriterLease(rootDir, {
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "tool-a",
      workId: "work-a",
      pendingMutationId: "pending-a",
      beforeSnapshot,
    });
    const asyncDir = await mkdtemp(path.join(os.tmpdir(), "ged-writer-run-"));
    await writeFile(
      path.join(asyncDir, "status.json"),
      JSON.stringify({ runId: "run-a", state: "running" }),
    );
    await activateCheckoutWriterLease(rootDir, first.id, "run-a", asyncDir);

    await expect(
      acquireCheckoutWriterLease(rootDir, {
        sessionId: "session-b",
        requestId: "request-b",
        toolCallId: "tool-b",
        workId: "work-b",
        pendingMutationId: "pending-b",
        beforeSnapshot,
      }),
    ).rejects.toThrow("checkout writer lease");

    await writeFile(
      path.join(asyncDir, "status.json"),
      JSON.stringify({ runId: "run-a", state: "complete" }),
    );
    await expect(terminalCheckoutWriterLease(rootDir)).resolves.toMatchObject({
      id: first.id,
      workId: "work-a",
      pendingMutationId: "pending-a",
    });
    await releaseCheckoutWriterLease(rootDir, first.id);
    const recovered = await acquireCheckoutWriterLease(rootDir, {
      sessionId: "session-b",
      requestId: "request-b",
      toolCallId: "tool-b",
      workId: "work-b",
      pendingMutationId: "pending-b",
      beforeSnapshot,
    });
    expect(recovered.id).not.toBe(first.id);
    await releaseCheckoutWriterLease(rootDir, recovered.id);
  });

  test("keeps unreadable and unproven launching leases fail-closed", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-writer-root-"));
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    const beforeSnapshot = await captureRepositorySnapshot(rootDir);
    await acquireCheckoutWriterLease(rootDir, {
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "tool-a",
      workId: "work-a",
      pendingMutationId: "pending-a",
      beforeSnapshot,
    });
    await expect(
      acquireCheckoutWriterLease(rootDir, {
        sessionId: "session-b",
        requestId: "request-b",
        toolCallId: "tool-b",
        workId: "work-b",
        pendingMutationId: "pending-b",
        beforeSnapshot,
      }),
    ).rejects.toThrow("is launching");
    await writeFile(
      path.join(
        rootDir,
        ".ged",
        "runtime",
        "checkout-writer-lease",
        "lease.json",
      ),
      "not json",
    );
    await expect(
      acquireCheckoutWriterLease(rootDir, {
        sessionId: "session-c",
        requestId: "request-c",
        toolCallId: "tool-c",
        workId: "work-c",
        pendingMutationId: "pending-c",
        beforeSnapshot,
      }),
    ).rejects.toThrow("unreadable and remains fail-closed");
  });
});

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import {
  type FileSetFingerprint,
  fingerprintFileSet,
} from "./content-fingerprint.js";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result";

interface PlanReviewResult {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
}

interface PlannotatorResponse<T> {
  status: "handled" | "unavailable" | "error";
  result?: T;
  error?: string;
}

interface GlimpsePromptResult {
  fallback?: boolean;
}

interface PlanServerResult {
  reviewId: string;
  url: string;
  waitForDecision: () => Promise<PlanReviewResult>;
  stop: () => void;
}

type PlannotatorServerModule = {
  startPlanReviewServer: (options: {
    plan: string;
    htmlContent: string;
    origin?: string;
    sharingEnabled?: boolean;
    shareBaseUrl?: string;
    pasteApiUrl?: string;
  }) => Promise<PlanServerResult>;
};

interface GlimpseFallbackDiagnostic {
  phase: string;
  message: string;
}

let lastGlimpseFallbackDiagnostic: GlimpseFallbackDiagnostic | null = null;

interface GlimpseModule {
  open: (
    html: string,
    options: {
      width: number;
      height: number;
      title: string;
      floating?: boolean;
      openLinks?: boolean;
    },
  ) => GlimpseWindow;
}

interface GlimpseWindow {
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "closed", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "message", listener: (data: unknown) => void): this;
  removeListener(event: "closed", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  close(): void;
}

interface PlanReviewDependencies {
  importGlimpse: () => Promise<GlimpseModule>;
  startServer: (planContent: string) => Promise<PlanServerResult | null>;
}

export interface PlanReviewToolOptions {
  requestGlimpse?: (planContent: string) => Promise<PlanReviewResult | null>;
}

export async function fingerprintPlanReviewArtifacts(
  rootDir: string,
  filePath: string,
): Promise<FileSetFingerprint> {
  const fullPath = resolve(rootDir, filePath);
  const artifactPaths =
    basename(fullPath) === "TASKS.md"
      ? [
          resolve(dirname(fullPath), "SPEC.md"),
          fullPath,
          resolve(dirname(fullPath), "TESTS.md"),
        ]
      : [fullPath];
  return fingerprintFileSet(rootDir, artifactPaths);
}

function samePlanBinding(
  left: FileSetFingerprint,
  right: FileSetFingerprint,
): boolean {
  return (
    left.digest === right.digest &&
    JSON.stringify(left.paths) === JSON.stringify(right.paths)
  );
}

export function registerPlanReviewTool(
  api: ExtensionAPI,
  options: PlanReviewToolOptions = {},
): void {
  api.registerTool({
    name: "gedpi_plan_review",
    label: "Review Plan",
    description:
      "Open the GedPi draft plan for visual review, preferring native Glimpse when available and falling back to Plannotator's browser UI. " +
      "Pass the path to a markdown plan file (e.g. .ged/work/main/TASKS.md). " +
      "The user can approve, deny with feedback, or request changes. " +
      "Returns the review decision. If no visual review surface is available, returns an error.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description:
            "Path to the markdown plan file, relative to the working directory.",
        },
      },
      required: ["filePath"],
    },

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const { filePath } = params as { filePath: string };
      const makeResult = (
        text: string,
        approved: boolean,
        feedback?: string,
        details: Record<string, unknown> = {},
      ) => ({
        content: [{ type: "text" as const, text }],
        details: {
          approved,
          feedback,
          glimpseFallback: getLastGlimpseFallbackDiagnostic(),
          ...details,
        },
      });

      if (!filePath?.trim()) {
        return makeResult("Error: filePath is required.", false);
      }

      const fullPath = resolve(ctx.cwd, filePath);
      let planContent: string;
      try {
        planContent = await readFile(fullPath, "utf-8");
      } catch {
        return makeResult(
          `Error: could not read ${filePath}. Write the plan file first.`,
          false,
        );
      }

      if (!planContent.trim()) {
        return makeResult(
          `Error: ${filePath} is empty. Write the plan content first.`,
          false,
        );
      }

      let planBinding: FileSetFingerprint;
      try {
        planBinding = await fingerprintPlanReviewArtifacts(ctx.cwd, fullPath);
        if ((await readFile(fullPath, "utf-8")) !== planContent) {
          return makeResult(
            "Error: plan bytes changed while the visual review was starting. Review the current plan again.",
            false,
          );
        }
      } catch (error) {
        return makeResult(
          `Error: could not bind the complete plan artifact set: ${error instanceof Error ? error.message : String(error)}`,
          false,
        );
      }

      const currentApprovedBinding =
        async (): Promise<FileSetFingerprint | null> => {
          try {
            const current = await fingerprintPlanReviewArtifacts(
              ctx.cwd,
              fullPath,
            );
            return samePlanBinding(planBinding, current) ? current : null;
          } catch {
            return null;
          }
        };
      const glimpseDecision = await (
        options.requestGlimpse ?? requestGlimpsePlanReview
      )(planContent);
      const glimpseFallback = getLastGlimpseFallbackDiagnostic();
      if (glimpseDecision) {
        if (glimpseDecision.approved && !(await currentApprovedBinding())) {
          return makeResult(
            "Plan approval is stale because SPEC.md, TASKS.md, or TESTS.md changed during visual review. Review the current plan again.",
            false,
            undefined,
            { surface: "glimpse", staleReview: true },
          );
        }
        return {
          content: [
            {
              type: "text",
              text: glimpseDecision.approved
                ? glimpseDecision.feedback
                  ? `Plan approved in Glimpse with notes:\n\n${glimpseDecision.feedback}`
                  : "Plan approved in Glimpse."
                : glimpseDecision.feedback
                  ? `Plan denied in Glimpse. Reviewer feedback:\n\n${glimpseDecision.feedback}`
                  : "Plan denied in Glimpse without specific feedback.",
            },
          ],
          details: {
            approved: glimpseDecision.approved,
            feedback: glimpseDecision.feedback,
            surface: "glimpse",
            glimpseFallback: null,
            ...(glimpseDecision.approved ? { planBinding } : {}),
          },
        };
      }

      const result = await requestPlanReview(api, planContent);

      if (result.status === "unavailable") {
        return makeResult(
          `Plannotator is unavailable: ${result.error ?? "extension not loaded or no UI support"}. Do not accept the plan while visual review is required.`,
          false,
        );
      }

      if (result.status === "error") {
        return makeResult(
          `Plannotator error: ${result.error}. Do not accept the plan while visual review is required.`,
          false,
        );
      }

      const reviewId = result.result?.reviewId;
      if (!reviewId) {
        return makeResult(
          "Plannotator returned no review ID. Do not accept the plan while visual review is required.",
          false,
        );
      }

      const decision = await waitForReviewDecision(api, reviewId);

      if (!decision) {
        return makeResult(
          "Plannotator review timed out. Do not accept the plan while visual review is required.",
          false,
        );
      }

      if (decision.approved) {
        if (!(await currentApprovedBinding())) {
          return makeResult(
            "Plan approval is stale because SPEC.md, TASKS.md, or TESTS.md changed during visual review. Review the current plan again.",
            false,
            undefined,
            { surface: "browser", staleReview: true },
          );
        }
        return {
          content: [
            {
              type: "text",
              text: decision.feedback
                ? `Plan approved with notes:\n\n${decision.feedback}`
                : "Plan approved.",
            },
          ],
          details: {
            approved: true,
            feedback: decision.feedback,
            surface: "browser",
            glimpseFallback,
            planBinding,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: decision.feedback
              ? `Plan denied. Reviewer feedback:\n\n${decision.feedback}`
              : "Plan denied without specific feedback.",
          },
        ],
        details: {
          approved: false,
          feedback: decision.feedback,
          surface: "browser",
          glimpseFallback,
        },
      };
    },
  });
}

export async function requestGlimpsePlanReview(
  planContent: string,
  deps: PlanReviewDependencies = {
    importGlimpse: async () => (await import("glimpseui")) as GlimpseModule,
    startServer: startNativePlanReviewServer,
  },
): Promise<PlanReviewResult | null> {
  lastGlimpseFallbackDiagnostic = null;
  let glimpse: GlimpseModule;
  try {
    glimpse = await deps.importGlimpse();
  } catch (err) {
    recordGlimpseFallback("glimpse-import", err);
    return null;
  }

  const server = await deps.startServer(planContent);
  if (!server) return null;

  let window: GlimpseWindow | null = null;
  const closeWindow = (): void => {
    const windowToClose = window;
    window = null;
    if (!windowToClose) return;
    try {
      windowToClose.close();
    } catch {}
  };

  try {
    const decisionPromise = server
      .waitForDecision()
      .then((decision) => ({
        type: "decision" as const,
        decision,
      }))
      .catch((err) => {
        recordGlimpseFallback("native-decision", err);
        return { type: "prompt" as const, result: null };
      });

    window = glimpse.open(buildGlimpsePlanReviewHtml(server.url), {
      width: 1200,
      height: 860,
      title: "Review GedPi plan",
      floating: true,
      openLinks: true,
    });
    const promptPromise = waitForGlimpsePromptResult(window).then((result) => ({
      type: "prompt" as const,
      result,
    }));

    const result = await Promise.race([decisionPromise, promptPromise]);
    if (result.type === "decision") {
      closeWindow();
      return normalizePlanReviewResult(result.decision);
    }

    closeWindow();
    recordGlimpseFallback(
      "prompt-closed",
      result.result?.fallback
        ? "Reviewer requested browser fallback from Glimpse."
        : "Glimpse prompt closed before a review decision.",
    );
    return null;
  } catch (err) {
    recordGlimpseFallback("glimpse-prompt", err);
    return null;
  } finally {
    setTimeout(() => server.stop(), 1500);
  }
}

function waitForGlimpsePromptResult(
  window: GlimpseWindow,
): Promise<GlimpsePromptResult | null> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      window.removeListener("message", onMessage);
      window.removeListener("closed", onClosed);
      window.removeListener("error", onError);
    };

    const settle = (result: GlimpsePromptResult | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onMessage = (data: unknown): void => {
      const result = data as GlimpsePromptResult;
      if (result?.fallback) {
        settle(result);
      }
    };

    const onClosed = (): void => settle(null);

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    window.on("message", onMessage);
    window.on("closed", onClosed);
    window.on("error", onError);
  });
}

async function startNativePlanReviewServer(
  planContent: string,
): Promise<PlanServerResult | null> {
  let serverModule: PlannotatorServerModule;
  let htmlContent: string;
  try {
    [serverModule, htmlContent] = await Promise.all([
      importPlannotatorServer(),
      readPlannotatorHtml(),
    ]);
  } catch (err) {
    recordGlimpseFallback("native-server-import", err);
    return null;
  }

  const { startPlanReviewServer } = serverModule;

  if (!htmlContent.trim()) {
    recordGlimpseFallback(
      "plannotator-html",
      "Plannotator HTML asset is empty.",
    );
    return null;
  }

  try {
    return await startPlanReviewServer({
      plan: planContent,
      htmlContent,
      origin: "gedpi-glimpse",
      sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
      shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
      pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
    });
  } catch (err) {
    recordGlimpseFallback("native-server-start", err);
    return null;
  }
}

export async function importPlannotatorServer(): Promise<PlannotatorServerModule> {
  const packageDir = resolvePlannotatorPackageDir();
  const jiti = createJiti(import.meta.url);
  const serverModule = await jiti.import<Partial<PlannotatorServerModule>>(
    resolve(packageDir, "server.ts"),
    { default: true },
  );

  if (typeof serverModule.startPlanReviewServer !== "function") {
    throw new Error(
      "Plannotator server module does not export startPlanReviewServer.",
    );
  }

  return serverModule as PlannotatorServerModule;
}

async function readPlannotatorHtml(): Promise<string> {
  return readFile(
    resolve(resolvePlannotatorPackageDir(), "plannotator.html"),
    "utf-8",
  );
}

function resolvePlannotatorPackageDir(): string {
  const packageJson = import.meta.resolve(
    "@plannotator/pi-extension/package.json",
  );
  return dirname(fileURLToPath(packageJson));
}

export function getLastGlimpseFallbackDiagnostic(): GlimpseFallbackDiagnostic | null {
  return lastGlimpseFallbackDiagnostic;
}

function recordGlimpseFallback(phase: string, error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";
  lastGlimpseFallbackDiagnostic = { phase, message };
  if (process.env.GEDPI_DEBUG_PLAN_REVIEW === "1") {
    console.warn(
      `[gedpi_plan_review] Glimpse fallback at ${phase}: ${message}`,
    );
  }
}

function normalizePlanReviewResult(result: PlanReviewResult): PlanReviewResult {
  return {
    approved: result.approved,
    feedback: result.feedback?.trim() || undefined,
    savedPath: result.savedPath,
    agentSwitch: result.agentSwitch,
    permissionMode: result.permissionMode,
  };
}

export function buildGlimpsePlanReviewHtml(reviewUrl: string): string {
  const escapedUrl = escapeHtml(reviewUrl);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
    .toolbar { height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
    .toolbar strong { font-size: 13px; }
    .actions { display: flex; gap: 8px; align-items: center; }
    a, button { border: 0; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; text-decoration: none; }
    a { background: color-mix(in srgb, CanvasText 10%, transparent); color: CanvasText; }
    button { background: #2563eb; color: white; }
    iframe { display: block; width: 100vw; height: calc(100vh - 45px); border: 0; background: Canvas; }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>Full Plannotator plan review</strong>
    <div class="actions">
      <a href="${escapedUrl}" target="_blank" rel="noreferrer">Open in browser</a>
      <button id="fallback">Use browser fallback</button>
    </div>
  </div>
  <iframe src="${escapedUrl}" title="Plannotator plan review"></iframe>
  <script>
    document.getElementById('fallback').addEventListener('click', () => window.glimpse.send({ fallback: true }));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.glimpse.send({ fallback: true });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requestPlanReview(
  api: ExtensionAPI,
  planContent: string,
): Promise<PlannotatorResponse<{ reviewId: string }>> {
  return new Promise((resolve) => {
    const requestId = `gedpi-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      resolve({
        status: "unavailable",
        error: "No response from Plannotator extension (timed out).",
      });
    }, 5_000);

    api.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
      requestId,
      action: "plan-review",
      payload: { planContent, origin: "gedpi" },
      respond(
        response: PlannotatorResponse<{ status: string; reviewId: string }>,
      ) {
        clearTimeout(timeout);
        if (response.status === "handled" && response.result) {
          resolve({
            status: "handled",
            result: { reviewId: response.result.reviewId },
          });
        } else {
          resolve(response as PlannotatorResponse<{ reviewId: string }>);
        }
      },
    });
  });
}

function waitForReviewDecision(
  api: ExtensionAPI,
  reviewId: string,
  timeoutMs = 600_000,
): Promise<PlanReviewResult | null> {
  return new Promise((res) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      res(null);
    }, timeoutMs);

    const unsubscribe = api.events.on(
      PLANNOTATOR_REVIEW_RESULT_CHANNEL,
      (data: unknown) => {
        const event = data as { reviewId?: string } & PlanReviewResult;
        if (event.reviewId === reviewId) {
          clearTimeout(timeout);
          unsubscribe();
          res({
            approved: event.approved,
            feedback: event.feedback,
            savedPath: event.savedPath,
            agentSwitch: event.agentSwitch,
            permissionMode: event.permissionMode,
          });
        }
      },
    );
  });
}

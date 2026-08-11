import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic.js";
import { createAdr } from "./durable-memory.js";
import { activeGedPaths } from "./ged-paths.js";

export interface SyncRequest {
  summary: string;
  decisions?: string[];
  nextHandoffNotes?: string[];
}

// Sync inputs (summary, decisions, handoff notes) come from the user
// or the brain at runtime. Bullets are nested under markdown headings
// so a decision containing newlines, an indented "- " line, or a "## "
// could quietly close out the active section or invent fake bullets.
// Collapse to one line, strip control chars, drop leading "##/-/+" so
// the rendered bullet stays well-formed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from runtime-provided bullets is the point.
const BULLET_CONTROL = /[\u0000-\u001f\u007f]/gu;

function sanitizeBulletLine(value: string, maxLen = 800): string {
  return value
    .replace(BULLET_CONTROL, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[-+#*]+\s*/u, "")
    .trim()
    .slice(0, maxLen);
}

async function appendBullets(
  filePath: string,
  heading: string,
  bullets: string[],
): Promise<void> {
  if (bullets.length === 0) {
    return;
  }

  const content = await readFile(filePath, "utf8");
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const sectionRegex = new RegExp(
    `(${escapedHeading}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`,
    "u",
  );
  const match = content.match(sectionRegex);
  if (!match) {
    await writeFileAtomic(
      filePath,
      `${content.trimEnd()}\n\n${heading}\n\n${bullets.map((bullet) => `- ${bullet}`).join("\n")}\n`,
    );
    return;
  }

  const prefix = match[1];
  const body = match[2].trimEnd();
  const merged = [body, ...bullets.map((bullet) => `- ${bullet}`)]
    .filter(Boolean)
    .join("\n");
  await writeFileAtomic(
    filePath,
    content.replace(sectionRegex, `${prefix}${merged}\n`),
  );
}

export async function syncGedMemory(
  rootDir: string,
  request: SyncRequest,
): Promise<void> {
  const paths = await activeGedPaths(rootDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  try {
    await readFile(paths.sessionSummaryPath, "utf8");
  } catch {
    await writeFileAtomic(
      paths.sessionSummaryPath,
      "# Session Summary\n\n## Current understanding\n\n-\n\n## Recent progress\n\n-\n\n## Next handoff notes\n\n-\n",
    );
  }
  const sessionPath = paths.sessionSummaryPath;

  const safeSummary = sanitizeBulletLine(request.summary);
  if (safeSummary) {
    await appendBullets(sessionPath, "## Recent progress", [safeSummary]);
  }
  const safeHandoff = (request.nextHandoffNotes ?? [])
    .map((note) => sanitizeBulletLine(note))
    .filter((note) => note.length > 0);
  await appendBullets(sessionPath, "## Next handoff notes", safeHandoff);

  const safeDecisions = (request.decisions ?? [])
    .map((decision) => sanitizeBulletLine(decision))
    .filter((decision) => decision.length > 0);

  if (safeDecisions.length > 0) {
    const digest = createHash("sha256")
      .update(safeDecisions.join("\0"))
      .digest("hex")
      .slice(0, 12);
    const date = new Date().toISOString().slice(0, 10);
    await createAdr(
      rootDir,
      `sync-${date}-${digest}`,
      `# Decisions captured during sync\n\nStatus: accepted\nDate: ${date}\n\n${safeDecisions
        .map(
          (decision) =>
            `- Decision: ${decision}\n  - Why: Captured during explicit Ged sync.\n  - Impact: To be refined when the trade-off requires more detail.`,
        )
        .join("\n\n")}\n`,
    );
  }
}

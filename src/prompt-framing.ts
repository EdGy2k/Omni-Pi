import { createHash } from "node:crypto";

export type PromptContentTrust =
  | "approved-instructions"
  | "durable-data"
  | "runtime-data";

function clipSection(value: string | null, maxChars: number): string {
  if (!value) return "- Missing";
  const trimmed = value.trim();
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, maxChars)}…`;
}

export function renderPromptContentBlock(
  trust: PromptContentTrust,
  file: string,
  value: string | null,
  maxChars: number,
): string {
  const content = clipSection(value, maxChars);
  let marker = `GED_${createHash("sha256")
    .update(`${trust}\0${file}\0${content}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase()}`;
  while (content.includes(marker)) marker += "_X";
  return [
    `<<<${marker}:BEGIN trust=${trust} file=${JSON.stringify(file)}>>>`,
    content,
    `<<<${marker}:END>>>`,
  ].join("\n");
}

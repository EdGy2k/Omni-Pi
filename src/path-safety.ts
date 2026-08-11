import { lstat } from "node:fs/promises";
import path from "node:path";

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Rejects writes whose lexical repository-relative path traverses an existing
 * symbolic-link component. Missing suffixes are safe to create after the last
 * verified real directory. This is an accident-prevention boundary, not an OS
 * sandbox against adversarial races after the check.
 */
async function assertSafeRepositoryPath(
  rootDir: string,
  targetPath: string,
  operation: "Read source" | "Write target",
): Promise<void> {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${operation} escapes the repository: ${targetPath}`);
  }

  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new Error(
          `${operation} traverses a symbolic link: ${path.relative(root, cursor)}`,
        );
      }
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
  }
}

export async function assertSafeRepositoryWritePath(
  rootDir: string,
  targetPath: string,
): Promise<void> {
  return assertSafeRepositoryPath(rootDir, targetPath, "Write target");
}

/** Rejects repository source paths that resolve through symbolic links. */
export async function assertSafeRepositoryReadPath(
  rootDir: string,
  sourcePath: string,
): Promise<void> {
  return assertSafeRepositoryPath(rootDir, sourcePath, "Read source");
}

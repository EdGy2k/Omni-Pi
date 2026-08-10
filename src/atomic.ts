import { randomBytes } from "node:crypto";
import {
  chmodSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

// Atomic write helpers. Writes to a sibling temp file in the same
// directory, then renames over the destination. POSIX rename(2) is
// atomic when the source and destination are on the same filesystem,
// so a reader (or a concurrent writer) never observes a partially
// written state file. On Windows the rename is also atomic when the
// destination exists.
//
// The temp suffix includes a random nonce so two concurrent writers
// to the same path don't collide on their temp files.

function tempPathFor(filePath: string): string {
  return `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
}

async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch {
    return undefined;
  }
}

function existingModeSync(filePath: string): number | undefined {
  try {
    return statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  const mode = await existingMode(filePath);
  try {
    await writeFile(tempPath, content, "utf8");
    if (mode !== undefined) {
      await chmod(tempPath, mode);
    }
    await rename(tempPath, filePath);
  } catch (error) {
    // Best-effort cleanup of the orphaned temp file; ignore failure
    // since the original error is what matters.
    try {
      await unlink(tempPath);
    } catch {
      /* temp may not exist */
    }
    throw error;
  }
}

/**
 * Atomically publishes a fully-written file without replacing an existing
 * destination. The sibling temporary file is fsynced before an exclusive
 * hard-link publication, so concurrent processes can safely converge on one
 * immutable record.
 */
export async function publishFileExclusive(
  filePath: string,
  content: string | Uint8Array,
): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  try {
    await link(tempPath, filePath);
    try {
      const directory = await open(path.dirname(filePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Some platforms/filesystems do not support directory fsync. The
      // exclusive hard-link publication remains atomic on those platforms.
    }
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return false;
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

export function writeFileAtomicSync(
  filePath: string,
  content: string | Uint8Array,
): void {
  const tempPath = tempPathFor(filePath);
  const mode = existingModeSync(filePath);
  try {
    writeFileSync(tempPath, content, "utf8");
    if (mode !== undefined) {
      chmodSync(tempPath, mode);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* temp may not exist */
    }
    throw error;
  }
}

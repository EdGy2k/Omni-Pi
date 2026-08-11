import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gedpi-pack-install-"));
let session;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "signal"})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

try {
  const packDir = path.join(tempRoot, "pack");
  const projectDir = path.join(tempRoot, "project");
  const agentDir = path.join(tempRoot, "agent");
  await Promise.all([
    mkdir(packDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ]);

  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", packDir], repoRoot),
  );
  assert.equal(packed.length, 1, "npm pack must produce exactly one tarball");
  const packResult = packed[0];
  assert.equal(packResult.version, "0.20.0");
  const packedPaths = packResult.files.map((entry) => entry.path);
  assert.ok(
    packedPaths.every((entry) => !entry.includes("node_modules/")),
    "tarball must not contain nested node_modules",
  );
  assert.ok(
    packedPaths.every((entry) => !entry.endsWith("package-lock.json")),
    "tarball must not contain nested package lockfiles",
  );
  assert.ok(
    packedPaths.every((entry) => !entry.includes("pi-codex-conversion")),
    "tarball paths must not contain the removed conversion package",
  );

  const tarballPath = path.join(packDir, packResult.filename);
  await writeFile(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ name: "gedpi-packed-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--install-strategy=nested",
      tarballPath,
    ],
    projectDir,
  );

  const gedpiRoot = path.join(projectDir, "node_modules", "gedpi");
  const installedPackagePath = path.join(gedpiRoot, "package.json");
  const installedPackage = JSON.parse(
    await readFile(installedPackagePath, "utf8"),
  );
  assert.equal(installedPackage.version, "0.20.0");
  assert.equal(
    installedPackage.dependencies["@howaboua/pi-codex-conversion"],
    undefined,
  );
  assert.equal(
    installedPackage.pi.extensions.some((entry) =>
      entry.includes("pi-codex-conversion"),
    ),
    false,
  );
  assert.ok(
    installedPackage.pi.extensions.includes(
      "./node_modules/@plannotator/pi-extension/index.ts",
    ),
  );

  const extensionPaths = installedPackage.pi.extensions.map((entry) =>
    path.resolve(gedpiRoot, entry),
  );
  const skillPaths = installedPackage.pi.skills.map((entry) =>
    path.resolve(gedpiRoot, entry),
  );
  await Promise.all(
    [...extensionPaths, ...skillPaths].map((entry) => access(entry)),
  );
  await access(path.join(gedpiRoot, "extensions", "ged-core", "index.ts"));

  const sdkEntry = path.join(
    gedpiRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  );
  await access(sdkEntry);
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const settingsManager = sdk.SettingsManager.inMemory({});
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
  });
  await resourceLoader.reload();
  const created = await sdk.createAgentSession({
    cwd: projectDir,
    agentDir,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(projectDir),
    settingsManager,
  });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);

  const toolNames = session.agent.state.tools.map((tool) => tool.name).sort();
  for (const nativeTool of ["read", "bash", "write", "edit"]) {
    assert.ok(
      toolNames.includes(nativeTool),
      `missing native ${nativeTool} tool`,
    );
  }
  assert.ok(toolNames.includes("gedpi_plan_review"));
  assert.equal(toolNames.includes("exec_command"), false);
  assert.equal(toolNames.includes("apply_patch"), false);

  console.log(
    JSON.stringify(
      {
        package: `gedpi@${installedPackage.version}`,
        packedFiles: packedPaths.length,
        extensionsLoaded: extensionPaths.length,
        nativeTools: ["read", "bash", "write", "edit"],
        planReviewTool: "gedpi_plan_review",
        conversionDependency: false,
      },
      null,
      2,
    ),
  );
} finally {
  session?.dispose();
  await rm(tempRoot, { recursive: true, force: true });
}

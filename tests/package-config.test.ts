import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

describe("package Pi configuration", () => {
  test("does not depend on pi-extension-settings", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      pi?: { extensions?: string[] };
      dependencies?: Record<string, unknown>;
    };
    const extensions = packageJson.pi?.extensions ?? [];

    const hasPiExtensionSettings = extensions.some((extension) =>
      extension.includes("pi-extension-settings"),
    );
    expect(hasPiExtensionSettings).toBe(false);

    const deps = packageJson.dependencies ?? {};
    expect(deps).not.toHaveProperty("@juanibiapina/pi-extension-settings");
  });

  test("ged-core extension is registered", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    const extensions = packageJson.pi?.extensions ?? [];

    const gedCoreIndex = extensions.indexOf("./extensions/ged-core/index.ts");
    expect(gedCoreIndex).toBeGreaterThanOrEqual(0);
  });

  test("latest scoped Pi review dependencies are configured", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
      engines?: Record<string, string>;
    };

    expect(packageJson.engines?.node).toBe(">=22.19.0");
    expect(packageJson.dependencies?.["@earendil-works/pi-ai"]).toBe("0.84.1");
    expect(packageJson.dependencies?.["@earendil-works/pi-agent-core"]).toBe(
      "0.84.1",
    );
    expect(packageJson.dependencies?.["@earendil-works/pi-coding-agent"]).toBe(
      "0.84.1",
    );
    expect(packageJson.dependencies?.["@earendil-works/pi-tui"]).toBe("0.84.1");
    expect(packageJson.overrides).not.toHaveProperty("@earendil-works/pi-tui");
    expect(packageJson.overrides).toMatchObject({
      "brace-expansion": "5.0.9",
      nanoid: "3.3.18",
      postcss: "8.5.26",
      undici: "8.9.0",
    });
    expect(packageJson.dependencies?.["@plannotator/pi-extension"]).toBe(
      "0.25.0",
    );
    expect(packageJson.dependencies?.glimpseui).toBe("0.8.1");
  });

  test("all local Pi extension paths exist", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    const extensions = packageJson.pi?.extensions ?? [];
    const localExtensions = extensions.filter(
      (extension) =>
        extension.startsWith("./extensions/") ||
        extension.startsWith("./vendor/"),
    );

    await Promise.all(
      localExtensions.map((extension) =>
        access(path.join(process.cwd(), extension)),
      ),
    );
  });

  test("Amp-style editor extensions are not packaged", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { files?: string[]; pi?: { extensions?: string[] } };

    for (const fileName of [
      "vendor/amp-editor.ts",
      "vendor/amp-command-palette.ts",
      "vendor/amp-user-message.ts",
    ]) {
      expect(packageJson.files ?? []).not.toContain(fileName);
    }
    for (const extensionPath of [
      "./vendor/amp-editor.ts",
      "./vendor/amp-user-message.ts",
    ]) {
      expect(packageJson.pi?.extensions ?? []).not.toContain(extensionPath);
    }
  });

  test("node_modules Pi extension paths are backed by declared dependencies", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      pi?: { extensions?: string[] };
      dependencies?: Record<string, unknown>;
    };
    const dependencies = packageJson.dependencies ?? {};
    const extensions = packageJson.pi?.extensions ?? [];

    for (const extension of extensions) {
      if (!extension.startsWith("./node_modules/")) continue;
      const withoutPrefix = extension.slice("./node_modules/".length);
      const [first, second] = withoutPrefix.split("/");
      const dependency = first.startsWith("@") ? `${first}/${second}` : first;
      expect(dependencies).toHaveProperty(dependency);
    }
  });

  test("keeps Plannotator and excludes the Codex conversion package", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      pi?: { extensions?: string[]; skills?: string[] };
      dependencies?: Record<string, unknown>;
    };
    const lock = JSON.parse(
      await readFile(path.join(process.cwd(), "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<
        string,
        { dependencies?: Record<string, unknown> } | undefined
      >;
    };

    expect(packageJson.dependencies).toHaveProperty(
      "@plannotator/pi-extension",
    );
    expect(packageJson.pi?.extensions ?? []).toContain(
      "./node_modules/@plannotator/pi-extension/index.ts",
    );
    expect(packageJson.pi?.skills ?? []).not.toContain(
      "./node_modules/@plannotator/pi-extension/skills",
    );
    expect(packageJson.pi?.skills ?? []).not.toContain(
      "./node_modules/pi-web-access/skills",
    );
    expect(packageJson.dependencies).not.toHaveProperty(
      "@howaboua/pi-codex-conversion",
    );
    expect(packageJson.pi?.extensions ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining("pi-codex-conversion")]),
    );
    expect(lock.packages?.[""]?.dependencies).not.toHaveProperty(
      "@howaboua/pi-codex-conversion",
    );
    expect(
      lock.packages?.["node_modules/@howaboua/pi-codex-conversion"],
    ).toBeUndefined();
  });
});

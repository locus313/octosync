import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const runtimeFiles = [
  "main.js",
  "manifest.json",
  "styles.css",
  "logo.png",
];

const vaultRoot = process.argv[2];

if (!vaultRoot) {
  console.error("Usage: npm run local-install -- <vault-root>");
  process.exit(1);
}

const resolvedVaultRoot = path.resolve(expandHome(vaultRoot));
const vaultStat = await statOrNull(resolvedVaultRoot);

if (!vaultStat?.isDirectory()) {
  console.error(`Vault root does not exist or is not a directory: ${resolvedVaultRoot}`);
  process.exit(1);
}

const pluginDir = path.join(resolvedVaultRoot, ".obsidian", "plugins", "octosync");
await fs.mkdir(pluginDir, { recursive: true });

for (const file of runtimeFiles) {
  const source = path.resolve(file);
  const sourceStat = await statOrNull(source);

  if (!sourceStat?.isFile()) {
    console.error(`Missing runtime file: ${source}`);
    console.error("Run npm run build before local-install, or use npm run local-install.");
    process.exit(1);
  }

  await fs.copyFile(source, path.join(pluginDir, file));
}

function expandHome(target) {
  if (target === "~") {
    return process.env.HOME ?? target;
  }

  if (target.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", target.slice(2));
  }

  return target;
}

console.log(`Installed Octosync to ${pluginDir}`);

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

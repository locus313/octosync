import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const E2E_BOOTSTRAP_PATH = ".octosync/e2e-bootstrap.md";
const E2E_BOOTSTRAP_CONTENT =
  "This ignored file keeps Octosync E2E branches from pointing at GitHub's synthetic empty tree.\n";

async function main() {
  const env = await loadEnv();
  const config = getConfig(env);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runRoot = path.join(repoRoot, "tmp", "e2e", runId);
  const vaultPath = path.join(runRoot, "vault");
  const userDataPath = path.join(runRoot, "obsidian-user-data");
  const branch = `${config.branchPrefix}-${runId}`.slice(0, 240);
  const github = new GitHubApi(config);
  let browser;
  let obsidian;
  let passed = false;

  console.log(`Octosync E2E run: ${runId}`);
  console.log(`Vault: ${vaultPath}`);
  console.log(`GitHub branch: ${branch}`);

  try {
    if (!config.allowExistingObsidian) {
      await assertNoExistingObsidianProcess();
    }

    await github.createEmptyBranch(branch);
    await prepareVault(vaultPath, {
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      branch,
    });
    await prepareObsidianUserData(userDataPath, vaultPath);

    const port = config.remoteDebuggingPort || await getFreePort();
    obsidian = launchObsidian(config.obsidianPath, userDataPath, port);
    browser = await connectToObsidian(port);
    const page = await getObsidianPage(browser, port, { runRoot, vaultPath });
    await waitForExpectedVault(page, vaultPath);
    await disableRestrictedMode(config, vaultPath);
    await enableOctosyncPlugin(config, vaultPath);
    await trustVaultIfPrompted(page);
    await waitForPlugin(page);

    await runTest("settings screen renders sync and indicator controls", async () => {
      await openOctosyncSettings(page);
    });

    await runTest("external local file changes light the local ribbon indicator", async () => {
      await fs.writeFile(path.join(vaultPath, "local-e2e.md"), "local e2e\n", "utf8");
      await waitForRibbonClass(page, "has-local-changes");
      const label = await getRibbonLabel(page);
      assert.match(label, /local vault changes/i);
    });

    await runTest("simulate plans local upload without mutating GitHub", async () => {
      const summary = await simulateSync(page);

      assert.match(summary, /Simulation:/);
      assert.match(summary, /1 uploaded/);
      assert.equal(await github.pathExists(branch, "local-e2e.md"), false);
    });

    await runTest("manual sync uploads local file to temporary branch", async () => {
      const summary = await syncNow(page);

      assert.match(summary, /1 uploaded/);
      assert.equal(await github.readFile(branch, "local-e2e.md"), "local e2e\n");
    });

    await runTest("remote change polling lights the remote ribbon indicator", async () => {
      await github.writeFile(branch, "remote-only.md", "remote e2e\n");
      await page.evaluate(async () => {
        const plugin = globalThis.app.plugins.plugins.octosync;
        await plugin.refreshRemoteChangeIndicator();
      });
      await waitForRibbonClass(page, "has-remote-changes");
      const label = await getRibbonLabel(page);
      assert.match(label, /remote GitHub changes/i);
    });

    await runTest("tracked local delete removes the remote file", async () => {
      const filePath = "deletes/local-delete.md";
      await writeLocalFile(page, vaultPath, filePath, "delete me remotely\n");
      assert.match(await syncNow(page), /1 uploaded/);
      assert.equal(await github.readFile(branch, filePath), "delete me remotely\n");

      await deleteLocalPath(page, vaultPath, filePath);
      const summary = await syncNow(page);

      assert.match(summary, /1 remote deletions/);
      assert.equal(await github.pathExists(branch, filePath), false);
      await assertLocalPathAbsent(page, filePath);
    });

    await runTest("tracked remote delete removes the local file", async () => {
      const filePath = "deletes/remote-delete.md";
      await github.writeFile(branch, filePath, "delete me locally\n");
      assert.match(await syncNow(page), /1 downloaded/);
      await assertLocalFileContent(page, filePath, "delete me locally\n");

      await github.deleteFile(branch, filePath);
      const summary = await syncNow(page);

      assert.match(summary, /1 local deletions/);
      await assertLocalPathAbsent(page, filePath);
      assert.equal(await github.pathExists(branch, filePath), false);
    });

    await runTest("empty folders sync through Octosync marker files", async () => {
      const localFolder = "folders/local-empty";
      const remoteFolder = "folders/remote-empty";
      await createLocalFolder(page, vaultPath, localFolder);

      const uploadSummary = await syncNow(page);
      assert.match(uploadSummary, /1 folders uploaded/);
      assert.equal(await github.pathExists(branch, `${localFolder}/.octosync-folder`), true);

      await github.writeFile(
        branch,
        `${remoteFolder}/.octosync-folder`,
        "Octosync placeholder for an empty Obsidian folder.\n",
      );
      const downloadSummary = await syncNow(page);

      assert.match(downloadSummary, /1 folders downloaded/);
      await assertLocalFolderExists(page, remoteFolder);
    });

    await runTest("same-path new local and remote files resolve with keep both", async () => {
      const filePath = "conflicts/new-same-path.md";
      await writeLocalFile(page, vaultPath, filePath, "new local\n");
      await github.writeFile(branch, filePath, "new remote\n");

      const summary = await simulateSync(page);
      assert.match(summary, /1 conflicts/);
      await assertLocalFileContent(page, filePath, "new local\n");
      assert.equal(await github.readFile(branch, filePath), "new remote\n");

      const resolutionSummary = await resolveConflicts(page, [filePath], "both");
      assert.match(resolutionSummary, /1 uploaded/);
      assert.match(resolutionSummary, /1 downloaded/);
      await assertLocalFileContent(page, filePath, "new remote\n");

      const conflictPath = await findLocalPath(
        path.join(vaultPath, "conflicts"),
        /^new-same-path\.local-conflict-\d{8}-\d{6}\.md$/,
      );
      assert(conflictPath, "Expected a local conflict copy.");
      assert.equal(await fs.readFile(conflictPath, "utf8"), "new local\n");
      const remoteConflictPath = await github.findPath(
        branch,
        /^conflicts\/new-same-path\.local-conflict-\d{8}-\d{6}\.md$/,
      );
      assert(remoteConflictPath, "Expected a remote conflict copy.");
      assert.equal(await github.readFile(branch, remoteConflictPath), "new local\n");
    });

    await runTest("local edit versus remote delete resolves by keeping local", async () => {
      const filePath = "conflicts/local-edit-remote-delete.md";
      await writeLocalFile(page, vaultPath, filePath, "base\n");
      assert.match(await syncNow(page), /1 uploaded/);

      await writeLocalFile(page, vaultPath, filePath, "local edit\n");
      await github.deleteFile(branch, filePath);

      const summary = await simulateSync(page);
      assert.match(summary, /1 conflicts/);
      await assertLocalFileContent(page, filePath, "local edit\n");
      assert.equal(await github.pathExists(branch, filePath), false);

      const resolutionSummary = await resolveConflicts(page, [filePath], "local");
      assert.match(resolutionSummary, /1 uploaded/);
      await assertLocalFileContent(page, filePath, "local edit\n");
      assert.equal(await github.readFile(branch, filePath), "local edit\n");
    });

    await runTest("local delete versus remote edit resolves by keeping remote", async () => {
      const filePath = "conflicts/local-delete-remote-edit.md";
      await writeLocalFile(page, vaultPath, filePath, "base\n");
      assert.match(await syncNow(page), /1 uploaded/);

      await deleteLocalPath(page, vaultPath, filePath);
      await github.writeFile(branch, filePath, "remote edit\n");

      const summary = await simulateSync(page);
      assert.match(summary, /1 conflicts/);
      await assertLocalPathAbsent(page, filePath);
      assert.equal(await github.readFile(branch, filePath), "remote edit\n");

      const resolutionSummary = await resolveConflicts(page, [filePath], "remote");
      assert.match(resolutionSummary, /1 downloaded/);
      await assertLocalFileContent(page, filePath, "remote edit\n");
      assert.equal(await github.readFile(branch, filePath), "remote edit\n");
    });

    await runTest("sync conflict does not apply unrelated downloads", async () => {
      const conflictPath = "conflicts/no-partial-apply.md";
      const remoteOnlyPath = "conflicts/unrelated-remote-only.md";
      await writeLocalFile(page, vaultPath, conflictPath, "base\n");
      assert.match(await syncNow(page), /1 uploaded/);

      await writeLocalFile(page, vaultPath, conflictPath, "local conflict\n");
      await github.writeFile(branch, conflictPath, "remote conflict\n");
      await github.writeFile(branch, remoteOnlyPath, "must not download yet\n");

      const summary = await syncNow(page);
      assert.match(summary, /Sync stopped with 1 conflict/);
      await assertLocalFileContent(page, conflictPath, "local conflict\n");
      await assertLocalPathAbsent(page, remoteOnlyPath);

      assert.match(await resolveConflicts(page, [conflictPath], "remote"), /1 downloaded/);
      assert.match(await syncNow(page), /1 downloaded/);
      await assertLocalFileContent(page, remoteOnlyPath, "must not download yet\n");
    });

    await runTest("simulate reports local/remote conflict without applying changes", async () => {
      await fs.writeFile(path.join(vaultPath, "local-e2e.md"), "local conflict\n", "utf8");
      await waitForRibbonClass(page, "has-local-changes");
      await github.writeFile(branch, "local-e2e.md", "remote conflict\n");

      const summary = await simulateSync(page);

      assert.match(summary, /1 conflicts/);
      assert.equal(await fs.readFile(path.join(vaultPath, "local-e2e.md"), "utf8"), "local conflict\n");
      assert.equal(await github.readFile(branch, "local-e2e.md"), "remote conflict\n");
    });

    console.log("E2E passed.");
    passed = true;
  } finally {
    const inspectAfterFailure = !passed && config.inspectOnFailure;

    if (inspectAfterFailure) {
      console.log("E2E failed; keeping Obsidian and artifacts open for inspection.");
      console.log(`Vault: ${vaultPath}`);
      console.log(`Run artifacts: ${runRoot}`);
      console.log(`GitHub branch: ${branch}`);
    }

    if (browser && !inspectAfterFailure) {
      await browser.close().catch(() => {});
    }

    if (obsidian && !obsidian.killed && !inspectAfterFailure) {
      obsidian.kill("SIGTERM");
    }

    if (config.keepArtifacts || inspectAfterFailure) {
      console.log(`Keeping E2E artifacts in ${runRoot}`);
      console.log(`Keeping GitHub branch ${branch}`);
    } else {
      await github.deleteBranch(branch).catch((error) => {
        console.warn(`Could not delete ${branch}: ${error.message}`);
      });
      await fs.rm(runRoot, { recursive: true, force: true });
    }
  }
}

async function runTest(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write("ok\n");
}

async function loadEnv() {
  const explicit = process.env.OCTOSYNC_E2E_ENV_FILE;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(repoRoot, ".env.e2e"), path.join(repoRoot, ".env")];
  const loaded = { ...process.env };

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      Object.assign(loaded, parseEnv(raw));
      loaded.OCTOSYNC_E2E_ENV_FILE = candidate;
      return loaded;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(
    [
      "Missing E2E environment file.",
      "",
      "To run Obsidian E2E tests:",
      "  1. Copy env.e2e.sample to .env.e2e",
      "  2. Fill in OCTOSYNC_E2E_GITHUB_TOKEN, OCTOSYNC_E2E_OWNER, and OCTOSYNC_E2E_REPO",
      "  3. Use a dedicated throwaway GitHub repo; the harness creates/deletes octosync-e2e-* branches",
      "  4. Run npm run test:e2e again",
      "",
      "You can also set OCTOSYNC_E2E_ENV_FILE=/path/to/envfile if you keep secrets elsewhere.",
    ].join("\n"),
  );
}

function parseEnv(raw) {
  const values = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function getConfig(env) {
  const required = [
    "OCTOSYNC_E2E_GITHUB_TOKEN",
    "OCTOSYNC_E2E_OWNER",
    "OCTOSYNC_E2E_REPO",
  ];
  const missing = required.filter((key) => !env[key]);

  if (missing.length > 0) {
    throw new Error(
      [
        `Missing E2E env value(s): ${missing.join(", ")}`,
        "",
        "Open your .env.e2e file and set:",
        "  OCTOSYNC_E2E_GITHUB_TOKEN=github_pat_...",
        "  OCTOSYNC_E2E_OWNER=your-owner-or-org",
        "  OCTOSYNC_E2E_REPO=your-throwaway-repo",
      ].join("\n"),
    );
  }

  return {
    token: env.OCTOSYNC_E2E_GITHUB_TOKEN,
    owner: env.OCTOSYNC_E2E_OWNER,
    repo: env.OCTOSYNC_E2E_REPO,
    branchPrefix: env.OCTOSYNC_E2E_BRANCH_PREFIX || "octosync-e2e",
    obsidianPath:
      env.OCTOSYNC_E2E_OBSIDIAN_PATH ||
      "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    obsidianCliPath:
      env.OCTOSYNC_E2E_OBSIDIAN_CLI_PATH ||
      getDefaultObsidianCliPath(
        env.OCTOSYNC_E2E_OBSIDIAN_PATH ||
          "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
      ),
    keepArtifacts: env.OCTOSYNC_E2E_KEEP_ARTIFACTS === "true",
    inspectOnFailure: env.OCTOSYNC_E2E_INSPECT_ON_FAILURE === "true",
    allowExistingObsidian: env.OCTOSYNC_E2E_ALLOW_EXISTING_OBSIDIAN === "true",
    remoteDebuggingPort: Number.parseInt(env.OCTOSYNC_E2E_REMOTE_DEBUGGING_PORT || "0", 10) || 0,
  };
}

function getDefaultObsidianCliPath(obsidianPath) {
  if (path.basename(obsidianPath) === "Obsidian") {
    return path.join(path.dirname(obsidianPath), "obsidian-cli");
  }

  return "obsidian";
}

async function assertNoExistingObsidianProcess() {
  if (process.platform !== "darwin") {
    return;
  }

  const processes = await listObsidianProcesses();

  if (processes.length === 0) {
    return;
  }

  throw new Error(
    [
      "Obsidian is already running.",
      "",
      "The E2E harness uses an isolated profile and disposable vault, but Obsidian can reuse an existing app instance on macOS.",
      "Close Obsidian before running E2E tests so the harness can prove it opened the throwaway vault.",
      "",
      "Detected process(es):",
      ...processes.map((line) => `  ${line}`),
      "",
      "To stop them:",
      "  pkill -TERM -f Obsidian",
      "",
      "To bypass this guard intentionally, set OCTOSYNC_E2E_ALLOW_EXISTING_OBSIDIAN=true.",
    ].join("\n"),
  );
}

async function listObsidianProcesses() {
  return new Promise((resolve, reject) => {
    execFile("pgrep", ["-fl", "Obsidian"], (error, stdout) => {
      if (error) {
        if (error.code === 1) {
          resolve([]);
          return;
        }

        reject(error);
        return;
      }

      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function prepareVault(vaultPath, settings) {
  const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "octosync");
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, ".obsidian", "community-plugins.json"), JSON.stringify(["octosync"], null, 2));
  await fs.writeFile(
    path.join(vaultPath, ".obsidian", "app.json"),
    JSON.stringify(
      {
        safeMode: false,
        restrictedMode: false,
      },
      null,
      2,
    ),
  );

  for (const filename of ["main.js", "manifest.json", "styles.css", "logo.png"]) {
    await fs.copyFile(path.join(repoRoot, filename), path.join(pluginPath, filename));
  }

  await fs.writeFile(
    path.join(pluginPath, "data.json"),
    JSON.stringify(
      {
        settings: {
          authMode: "pat",
          token: settings.token,
          owner: settings.owner,
          repo: settings.repo,
          branch: settings.branch,
          syncMode: "manual",
          confirmBeforeManualSync: false,
          localChangeIndicatorEnabled: true,
          localChangePeriodicFullScan: false,
          remoteChangeIndicatorEnabled: true,
          remoteChangeCheckIntervalMinutes: 1,
          debugLogging: true,
        },
        metadata: {
          version: 1,
          files: {},
          folders: {},
        },
      },
      null,
      2,
    ),
  );
}

async function prepareObsidianUserData(userDataPath, vaultPath) {
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(userDataPath, "obsidian.json"),
    JSON.stringify(
      {
        vaults: {
          "octosync-e2e": {
            path: vaultPath,
            ts: Date.now(),
            open: true,
          },
        },
        cli: true,
      },
      null,
      2,
    ),
  );
}

function launchObsidian(obsidianPath, userDataPath, port) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataPath}`,
  ];
  const child = spawn(obsidianPath, args, {
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    if (process.env.OCTOSYNC_E2E_VERBOSE === "true") {
      process.stdout.write(`[obsidian] ${data}`);
    }
  });
  child.stderr.on("data", (data) => {
    if (process.env.OCTOSYNC_E2E_VERBOSE === "true") {
      process.stderr.write(`[obsidian] ${data}`);
    }
  });

  return child;
}

async function connectToObsidian(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  const started = Date.now();

  while (Date.now() - started < 30000) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return chromium.connectOverCDP(endpoint);
      }
    } catch {
      // Keep waiting; Obsidian takes a moment to expose CDP.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Obsidian CDP at ${endpoint}`);
}

async function getObsidianPage(browser, port, context) {
  const started = Date.now();

  while (Date.now() - started < 60000) {
    const existing = findObsidianPage(browser);

    if (existing) {
      return existing;
    }

    await delay(500);
  }

  const targets = await getDebugTargets(port);
  throw new Error(
    [
      "Timed out waiting for an Obsidian browser window.",
      "",
      `Vault: ${context.vaultPath}`,
      `Run artifacts: ${context.runRoot}`,
      `CDP target count: ${targets.length}`,
      ...targets.map((target) => `  - ${target.type || "unknown"} ${target.title || "(untitled)"} ${target.url || ""}`),
      "",
      "Troubleshooting:",
      "  - Set OCTOSYNC_E2E_INSPECT_ON_FAILURE=true to keep Obsidian and the throwaway vault open.",
      "  - Set OCTOSYNC_E2E_VERBOSE=true to print Obsidian stdout/stderr.",
      "  - Check OCTOSYNC_E2E_OBSIDIAN_PATH points at the Obsidian executable.",
    ].join("\n"),
  );
}

function findObsidianPage(browser) {
  for (const context of browser.contexts()) {
    const page = context.pages().find((candidate) => {
      const url = candidate.url();
      return url && !url.startsWith("devtools://") && !url.startsWith("chrome-devtools://");
    });

    if (page) {
      return page;
    }
  }

  return null;
}

async function waitForExpectedVault(page, expectedVaultPath) {
  await page.waitForFunction(
    () => Boolean(globalThis.app?.vault?.adapter),
    undefined,
    { timeout: 45000 },
  );

  const actualVaultPath = await page.evaluate(() => {
    const adapter = globalThis.app?.vault?.adapter;

    if (!adapter) {
      return null;
    }

    if (typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }

    if (typeof adapter.basePath === "string") {
      return adapter.basePath;
    }

    return null;
  });

  assert.equal(
    normalizeVaultPath(actualVaultPath),
    normalizeVaultPath(expectedVaultPath),
    [
      "Obsidian opened the wrong vault.",
      `Expected: ${expectedVaultPath}`,
      `Actual: ${actualVaultPath || "(unknown)"}`,
      "The E2E run has stopped before invoking Octosync.",
    ].join("\n"),
  );
}

async function disableRestrictedMode(config, vaultPath) {
  await runObsidianCli(config, vaultPath, ["plugins:restrict", "off"]);
}

async function enableOctosyncPlugin(config, vaultPath) {
  await runObsidianCli(config, vaultPath, [
    "plugin:enable",
    "id=octosync",
    "filter=community",
  ]);
}

async function runObsidianCli(config, vaultPath, args) {
  const attempts = [];
  const commandAttempts = [
    [config.obsidianCliPath, args],
    [config.obsidianCliPath, [`vault=octosync-e2e`, ...args]],
  ];

  for (const [command, commandArgs] of commandAttempts) {
    try {
      const result = await execFileAsync(command, commandArgs, {
        cwd: vaultPath,
        timeout: 15000,
      });

      if (process.env.OCTOSYNC_E2E_VERBOSE === "true" && result.stdout.trim()) {
        process.stdout.write(`[obsidian-cli] ${result.stdout}`);
      }

      return result;
    } catch (error) {
      attempts.push(formatExecError(command, commandArgs, error));
    }
  }

  throw new Error(
    [
      `Obsidian CLI command failed: ${args.join(" ")}`,
      "",
      "Attempts:",
      ...attempts.map((attempt) => `  - ${attempt}`),
    ].join("\n"),
  );
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function formatExecError(command, args, error) {
  const message = error instanceof Error ? error.message : String(error);
  const stdout = error?.stdout ? ` stdout=${JSON.stringify(String(error.stdout).trim())}` : "";
  const stderr = error?.stderr ? ` stderr=${JSON.stringify(String(error.stderr).trim())}` : "";
  return `${command} ${args.join(" ")}: ${message}${stdout}${stderr}`;
}

async function trustVaultIfPrompted(page) {
  const started = Date.now();

  while (Date.now() - started < 15000) {
    const result = await page.evaluate(() => {
      if (globalThis.app?.plugins?.plugins?.octosync) {
        return "plugin-loaded";
      }

      const buttons = Array.from(document.querySelectorAll("button"));
      const trustButton = buttons.find((button) =>
        button.textContent?.trim() === "Trust author and enable plugins"
      );

      if (trustButton instanceof HTMLElement) {
        trustButton.click();
        return "trusted";
      }

      const restrictedModePrompt = document.body.innerText.includes("Do you trust the author of this vault?");
      return restrictedModePrompt ? "waiting" : "absent";
    });

    if (result === "trusted") {
      await page.waitForFunction(
        () => !document.body.innerText.includes("Do you trust the author of this vault?"),
        undefined,
        { timeout: 10000 },
      );
      return;
    }

    if (result === "plugin-loaded" || result === "absent") {
      return;
    }

    await delay(500);
  }

  throw new Error("Obsidian showed the vault trust prompt, but the E2E harness could not enable plugins.");
}

function normalizeVaultPath(vaultPath) {
  return typeof vaultPath === "string" ? path.resolve(vaultPath) : vaultPath;
}

async function getDebugTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return response.ok ? await response.json() : [];
  } catch {
    return [];
  }
}

async function waitForPlugin(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.app?.plugins?.plugins?.octosync),
    undefined,
    { timeout: 45000 },
  );
}

async function openOctosyncSettings(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.app?.setting?.open && globalThis.app?.setting?.openTabById),
    undefined,
    { timeout: 30000 },
  );

  await page.waitForFunction(
    () => {
      globalThis.app.setting.open();
      globalThis.app.setting.openTabById("octosync");
      const bodyText = document.body.innerText;
      return (
        bodyText.includes("Sync mode") &&
        bodyText.includes("Unsynced local changes indicator") &&
        bodyText.includes("Remote changes indicator")
      );
    },
    undefined,
    { timeout: 30000, polling: 500 },
  );
}

async function expectBodyText(page, text, timeout = 10000) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    text,
    { timeout },
  );
}

async function waitForRibbonClass(page, className) {
  await page.waitForFunction(
    (targetClass) => Boolean(document.querySelector(`.workspace-ribbon .clickable-icon.${targetClass}`)),
    className,
    { timeout: 15000 },
  );
}

async function getRibbonLabel(page) {
  return page.evaluate(() => {
    const icon = document.querySelector(".workspace-ribbon .clickable-icon[aria-label*='Octosync']");
    return icon?.getAttribute("aria-label") || "";
  });
}

async function syncNow(page) {
  return page.evaluate(async () => {
    const plugin = globalThis.app.plugins.plugins.octosync;
    await plugin.syncNow();
    return plugin.settings.lastSyncSummary;
  });
}

async function simulateSync(page) {
  return page.evaluate(async () => {
    const plugin = globalThis.app.plugins.plugins.octosync;
    await plugin.simulateSync();
    return plugin.settings.lastSyncSummary;
  });
}

async function resolveConflicts(page, paths, resolution) {
  return page.evaluate(
    async ({ paths, resolution }) => {
      const plugin = globalThis.app.plugins.plugins.octosync;
      await plugin.resolveConflicts(paths, resolution);
      return plugin.settings.lastSyncSummary;
    },
    { paths, resolution },
  );
}

async function writeLocalFile(page, vaultPath, filePath, content) {
  const absolutePath = path.join(vaultPath, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  await assertLocalFileContent(page, filePath, content);
  await waitForRibbonClass(page, "has-local-changes");
}

async function deleteLocalPath(page, vaultPath, filePath) {
  await fs.rm(path.join(vaultPath, filePath), { recursive: true, force: true });
  await assertLocalPathAbsent(page, filePath);
  await waitForRibbonClass(page, "has-local-changes");
}

async function createLocalFolder(page, vaultPath, folderPath) {
  await fs.mkdir(path.join(vaultPath, folderPath), { recursive: true });
  await assertLocalFolderExists(page, folderPath);
  await waitForRibbonClass(page, "has-local-changes");
}

async function assertLocalFileContent(page, filePath, expectedContent) {
  await page.waitForFunction(
    async ({ filePath, expectedContent }) => {
      const file = globalThis.app?.vault?.getAbstractFileByPath(filePath);

      if (!file || "children" in file) {
        return false;
      }

      try {
        return await globalThis.app.vault.read(file) === expectedContent;
      } catch {
        return false;
      }
    },
    { filePath, expectedContent },
    { timeout: 15000 },
  );
}

async function assertLocalFolderExists(page, folderPath) {
  await page.waitForFunction(
    (folderPath) => {
      const folder = globalThis.app?.vault?.getAbstractFileByPath(folderPath);
      return Boolean(folder && "children" in folder);
    },
    folderPath,
    { timeout: 15000 },
  );
}

async function assertLocalPathAbsent(page, filePath) {
  await page.waitForFunction(
    (filePath) => !globalThis.app?.vault?.getAbstractFileByPath(filePath),
    filePath,
    { timeout: 15000 },
  );
}

async function findLocalPath(rootPath, pattern) {
  let entries;

  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      const nested = await findLocalPath(entryPath, pattern);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (pattern.test(entry.name)) {
      return entryPath;
    }
  }

  return null;
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

class GitHubApi {
  constructor(config) {
    this.config = config;
  }

  async createEmptyBranch(branch) {
    const baseSha = await this.ensureRepositoryHasInitialCommit();
    const blob = await this.request("/git/blobs", {
      method: "POST",
      body: {
        content: Buffer.from(E2E_BOOTSTRAP_CONTENT, "utf8").toString("base64"),
        encoding: "base64",
      },
    });
    const tree = await this.request("/git/trees", {
      method: "POST",
      body: {
        tree: [
          {
            path: E2E_BOOTSTRAP_PATH,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          },
        ],
      },
    });
    const commit = await this.request("/git/commits", {
      method: "POST",
      body: {
        message: "Create isolated Octosync E2E branch",
        tree: tree.sha,
        parents: [baseSha],
      },
    });

    await this.request("/git/refs", {
      method: "POST",
      body: {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      },
    });
  }

  async ensureRepositoryHasInitialCommit() {
    const repo = await this.request("");
    const defaultBranch = repo.default_branch;

    try {
      const ref = await this.request(`/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
      return ref.object.sha;
    } catch (error) {
      if (!String(error.message).includes("Git Repository is empty")) {
        throw error;
      }
    }

    const created = await this.request(`/contents/${encodePath(E2E_BOOTSTRAP_PATH)}`, {
      method: "PUT",
      body: {
        message: "Bootstrap repository for Octosync E2E",
        content: Buffer.from(E2E_BOOTSTRAP_CONTENT, "utf8").toString("base64"),
      },
    });

    return created.commit.sha;
  }

  async deleteBranch(branch) {
    await this.request(`/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "DELETE",
      allow404: true,
      allow409: true,
    });
  }

  async pathExists(branch, filePath) {
    const files = await this.getRemoteFiles(branch);
    return files.has(filePath);
  }

  async findPath(branch, pattern) {
    const files = await this.getRemoteFiles(branch);

    for (const filePath of files.keys()) {
      if (pattern.test(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  async readFile(branch, filePath) {
    const files = await this.getRemoteFiles(branch);
    const file = files.get(filePath);
    assert(file, `Remote path ${filePath} does not exist`);
    const blob = await this.request(`/git/blobs/${encodeURIComponent(file.sha)}`);
    const content = blob.encoding === "base64"
      ? Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8")
      : blob.content;
    return content;
  }

  async writeFile(branch, filePath, content) {
    const remote = await this.getRemoteState(branch);
    const blob = await this.request("/git/blobs", {
      method: "POST",
      body: {
        content: Buffer.from(content, "utf8").toString("base64"),
        encoding: "base64",
      },
    });
    const tree = await this.request("/git/trees", {
      method: "POST",
      body: {
        base_tree: remote.treeSha,
        tree: [
          {
            path: filePath,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          },
        ],
      },
    });
    const commit = await this.request("/git/commits", {
      method: "POST",
      body: {
        message: `Octosync E2E update ${filePath}`,
        tree: tree.sha,
        parents: [remote.commitSha],
      },
    });
    await this.request(`/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: {
        sha: commit.sha,
        force: false,
      },
    });
  }

  async deleteFile(branch, filePath) {
    const existing = await this.request(
      `/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`,
      { allow404: true },
    );

    if (!existing) {
      return;
    }

    await this.request(`/contents/${encodePath(filePath)}`, {
      method: "DELETE",
      body: {
        message: `Octosync E2E delete ${filePath}`,
        sha: existing.sha,
        branch,
      },
    });
  }

  async getRemoteState(branch) {
    const ref = await this.request(`/git/ref/heads/${encodeURIComponent(branch)}`);
    const commit = await this.request(`/git/commits/${encodeURIComponent(ref.object.sha)}`);
    return {
      commitSha: commit.sha,
      treeSha: commit.tree.sha,
    };
  }

  async getRemoteFiles(branch) {
    const remote = await this.getRemoteState(branch);
    const tree = await this.request(`/git/trees/${encodeURIComponent(remote.treeSha)}?recursive=1`);
    const files = new Map();

    for (const entry of tree.tree) {
      if (entry.type === "blob") {
        files.set(entry.path, entry);
      }
    }

    return files;
  }

  async request(pathname, options = {}) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${pathname}`,
      {
        method: options.method || "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      },
    );

    if (options.allow404 && response.status === 404) {
      return null;
    }

    if (options.allow409 && response.status === 409) {
      return null;
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(
        `GitHub ${options.method || "GET"} ${pathname} failed with ${response.status}: ${text}`,
      );
    }

    return body;
  }
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

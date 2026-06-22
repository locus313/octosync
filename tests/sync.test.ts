import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { GitHubRequestError, type GitHubClient } from "../src/github";
import { base64ToBytes, bytesToBase64, gitBlobSha } from "../src/hash";
import { MetadataStore } from "../src/metadata";
import {
  SyncConflictError,
  SyncManager,
  formatSummary,
  getConfigAllowedPaths,
  hasUserVisibleSyncChanges,
  matchesExcludePattern,
  shouldIgnorePath,
} from "../src/sync";
import { DEFAULT_SETTINGS, type OctosyncSettings, type RemoteFile } from "../src/types";

const settings: OctosyncSettings = {
  ...DEFAULT_SETTINGS,
  token: "token",
  owner: "owner",
  repo: "repo",
  branch: "main",
};

describe("sync helpers", () => {
  it("formats zero-change summaries as up to date", () => {
    const summary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      foldersUploaded: 0,
      foldersDownloaded: 0,
      foldersDeletedLocal: 0,
      foldersDeletedRemote: 0,
      conflicts: [],
    };

    expect(hasUserVisibleSyncChanges(summary)).toBe(false);
    expect(formatSummary(summary)).toBe("No sync required. Everything is up to date.");
  });

  it("formats summaries with conflict counts", () => {
    expect(
      formatSummary({
        uploaded: 1,
        downloaded: 2,
        deletedLocal: 3,
        deletedRemote: 4,
        foldersUploaded: 5,
        foldersDownloaded: 6,
        foldersDeletedLocal: 7,
        foldersDeletedRemote: 8,
        conflicts: ["note.md"],
      }),
    ).toBe(
      "1 uploaded, 2 downloaded, 3 local deletions, 4 remote deletions, 5 folders uploaded, 6 folders downloaded, 7 local folder deletions, 8 remote folder deletions, 1 conflicts",
    );
  });

  it("ignores the configured Obsidian config folder, Git, trash, Octosync, marker, and reserved files", () => {
    expect(shouldIgnorePath(".git/config", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath(".custom-obsidian/workspace.json", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath(".obsidian/workspace.json", ".custom-obsidian")).toBe(false);
    expect(shouldIgnorePath(".trash/deleted.md", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath(".octosync/state.json", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath(".gitignore", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath(".DS_Store", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath("empty/.octosync-folder", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath("notes/.gitignore", ".custom-obsidian")).toBe(false);
    expect(shouldIgnorePath("notes/today.md", ".custom-obsidian")).toBe(false);
  });

  it("allows config subpaths that are in the allowedConfigPaths list", () => {
    const configDir = ".obsidian";
    const allowed = [".obsidian/plugins", ".obsidian/community-plugins.json"];

    // Allowed paths should not be ignored
    expect(shouldIgnorePath(".obsidian/plugins", configDir, allowed)).toBe(false);
    expect(shouldIgnorePath(".obsidian/plugins/some-plugin/main.js", configDir, allowed)).toBe(false);
    expect(shouldIgnorePath(".obsidian/community-plugins.json", configDir, allowed)).toBe(false);

    // Non-allowed config paths are still ignored
    expect(shouldIgnorePath(".obsidian/workspace.json", configDir, allowed)).toBe(true);
    expect(shouldIgnorePath(".obsidian/app.json", configDir, allowed)).toBe(true);
    expect(shouldIgnorePath(".obsidian/themes/mytheme.css", configDir, allowed)).toBe(true);
  });

  it("always excludes known sensitive plugin filenames even when syncCommunityPlugins is enabled", () => {
    const configDir = ".obsidian";
    const allowed = getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: true }, configDir);

    // secure-credentials.dat is blocked regardless of allow-list
    expect(shouldIgnorePath(".obsidian/plugins/github-copilot/secure-credentials.dat", configDir, allowed)).toBe(true);

    // Other plugin files are still synced
    expect(shouldIgnorePath(".obsidian/plugins/github-copilot/main.js", configDir, allowed)).toBe(false);
    expect(shouldIgnorePath(".obsidian/plugins/github-copilot/data.json", configDir, allowed)).toBe(false);
    expect(shouldIgnorePath(".obsidian/plugins/github-copilot/manifest.json", configDir, allowed)).toBe(false);
  });

  it("respects user-defined exclude patterns via shouldIgnorePath", () => {
    const configDir = ".obsidian";
    const allowed = getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: true }, configDir);

    // Path-prefix pattern
    const excludeByPath = [".obsidian/plugins/some-plugin/data.json"];
    expect(shouldIgnorePath(".obsidian/plugins/some-plugin/data.json", configDir, allowed, excludeByPath)).toBe(true);
    expect(shouldIgnorePath(".obsidian/plugins/other-plugin/data.json", configDir, allowed, excludeByPath)).toBe(false);

    // Folder-prefix pattern
    const excludeByFolder = [".obsidian/plugins/some-plugin"];
    expect(shouldIgnorePath(".obsidian/plugins/some-plugin/main.js", configDir, allowed, excludeByFolder)).toBe(true);
    expect(shouldIgnorePath(".obsidian/plugins/some-plugin", configDir, allowed, excludeByFolder)).toBe(true);
    expect(shouldIgnorePath(".obsidian/plugins/other-plugin/main.js", configDir, allowed, excludeByFolder)).toBe(false);

    // Filename-only pattern (no slash) matches anywhere
    const excludeByName = ["data.json"];
    expect(shouldIgnorePath(".obsidian/plugins/some-plugin/data.json", configDir, allowed, excludeByName)).toBe(true);
    expect(shouldIgnorePath(".obsidian/plugins/other-plugin/data.json", configDir, allowed, excludeByName)).toBe(true);
    expect(shouldIgnorePath(".obsidian/plugins/some-plugin/main.js", configDir, allowed, excludeByName)).toBe(false);
  });

  it("matchesExcludePattern handles path-prefix and filename patterns", () => {
    // Path prefix (contains /)
    expect(matchesExcludePattern(".obsidian/plugins/foo/data.json", ".obsidian/plugins/foo/data.json")).toBe(true);
    expect(matchesExcludePattern(".obsidian/plugins/foo/main.js", ".obsidian/plugins/foo")).toBe(true);
    expect(matchesExcludePattern(".obsidian/plugins/foo/sub/file.js", ".obsidian/plugins/foo")).toBe(true);
    expect(matchesExcludePattern(".obsidian/plugins/foobar/main.js", ".obsidian/plugins/foo")).toBe(false);

    // Filename only (no /)
    expect(matchesExcludePattern("notes/data.json", "data.json")).toBe(true);
    expect(matchesExcludePattern(".obsidian/plugins/foo/data.json", "data.json")).toBe(true);
    expect(matchesExcludePattern(".obsidian/plugins/foo/main.js", "data.json")).toBe(false);
  });

  it("getConfigAllowedPaths returns correct paths based on settings", () => {
    const configDir = ".obsidian";

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: false, syncThemes: false, syncSnippets: false }, configDir),
    ).toEqual([]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: true }, configDir),
    ).toEqual([".obsidian/plugins", ".obsidian/community-plugins.json"]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncThemes: true }, configDir),
    ).toEqual([".obsidian/themes"]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncSnippets: true }, configDir),
    ).toEqual([".obsidian/snippets"]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: true, syncThemes: true, syncSnippets: true }, configDir),
    ).toEqual([".obsidian/plugins", ".obsidian/community-plugins.json", ".obsidian/themes", ".obsidian/snippets"]);
  });
});

describe("SyncManager", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { setTimeout });
    MockGitHubClient.reset();
  });

  it("uploads local-only files and records metadata", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("note.md", "local");

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.uploaded).toBe(1);
    expect(await github.readRemoteText("note.md")).toBe("local");
    expect(metadata.get("note.md")?.sha).toBe(github.remote.get("note.md")?.sha);
    expect(github.commits).toBe(1);
  });

  it("plans sync without changing local files, remote files, or metadata", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("local.md", "local");
    await github.addRemoteFile("remote.md", "remote");

    const summary = await createManager(vault, github, metadata).planSync();

    expect(summary.uploaded).toBe(1);
    expect(summary.downloaded).toBe(1);
    expect(github.remote.has("local.md")).toBe(false);
    expect(vault.exists("remote.md")).toBe(false);
    expect(metadata.get("local.md")).toBeUndefined();
    expect(metadata.get("remote.md")).toBeUndefined();
  });

  it("reports planned conflicts without throwing during planning", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    vault.addFile("note.md", "local");
    await github.addRemoteFile("note.md", "remote");

    const summary = await createManager(vault, github, metadata).planSync();

    expect(summary.conflicts).toEqual(["note.md"]);
    expect(vault.readText("note.md")).toBe("local");
    expect(await github.readRemoteText("note.md")).toBe("remote");
    expect(metadata.get("note.md")?.sha).toBe(oldSha);
  });

  it("treats local files that block remote folders as conflicts", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("Notes", "local file\n");
    await github.addRemoteFile("Notes/A.md", "remote nested\n");

    const summary = await createManager(vault, github, metadata).planSync();

    expect(summary.conflicts).toEqual(["Notes"]);
    await expect(createManager(vault, github, metadata).sync()).rejects.toThrow(SyncConflictError);
    expect(vault.readText("Notes")).toBe("local file\n");
    expect(github.commits).toBe(0);
  });

  it("treats remote files that block local folders as conflicts", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("Notes/A.md", "local nested\n");
    await github.addRemoteFile("Notes", "remote file\n");

    const summary = await createManager(vault, github, metadata).planSync();

    expect(summary.conflicts).toEqual(["Notes"]);
    await expect(createManager(vault, github, metadata).sync()).rejects.toThrow(SyncConflictError);
    expect(vault.readText("Notes/A.md")).toBe("local nested\n");
    expect(await github.readRemoteText("Notes")).toBe("remote file\n");
    expect(github.commits).toBe(0);
  });

  it("downloads remote-only files and records metadata", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    await github.addRemoteFile("folder/remote.md", "remote");

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.downloaded).toBe(1);
    expect(vault.readText("folder/remote.md")).toBe("remote");
    expect(metadata.get("folder/remote.md")?.sha).toBe(github.remote.get("folder/remote.md")?.sha);
  });

  it("does nothing when local, remote, and metadata agree", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addRemoteFile("note.md", "same");
    vault.addFile("note.md", "same");
    metadata.update("note.md", { sha, dirty: false, deleted: false }, 1);

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.uploaded).toBe(0);
    expect(summary.downloaded).toBe(0);
    expect(github.commits).toBe(0);
  });

  it("skips confirmation when a plan has no user-visible changes", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addRemoteFile("note.md", "same");
    vault.addFile("note.md", "same");
    const confirmPlan = vi.fn(async () => true);

    const summary = await createManager(vault, github, metadata).syncWithConfirmation(confirmPlan);

    expect(confirmPlan).not.toHaveBeenCalled();
    expect(summary).not.toBeNull();
    expect(formatSummary(summary!)).toBe("No sync required. Everything is up to date.");
    expect(metadata.get("note.md")?.sha).toBe(sha);
    expect(github.commits).toBe(0);
  });

  it("asks for confirmation when a plan has user-visible changes", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("note.md", "local");
    const confirmPlan = vi.fn(async () => false);

    const summary = await createManager(vault, github, metadata).syncWithConfirmation(confirmPlan);

    expect(summary).toBeNull();
    expect(confirmPlan).toHaveBeenCalledWith(expect.objectContaining({ uploaded: 1 }));
    expect(github.remote.has("note.md")).toBe(false);
    expect(github.commits).toBe(0);
  });

  it("detects no local pending changes when local files match metadata", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addBlob("same");
    vault.addFile("note.md", "same");
    metadata.update("note.md", { sha, dirty: false, deleted: false }, 1);

    await expect(createManager(vault, github, metadata).hasLocalChanges()).resolves.toBe(false);
  });

  it("detects local-only and locally edited files without consulting remote state", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addBlob("old");
    vault.addFile("new.md", "new");
    vault.addFile("edited.md", "edited");
    metadata.update("edited.md", { sha, dirty: false, deleted: false }, 1);

    await expect(createManager(vault, github, metadata).hasLocalChanges()).resolves.toBe(true);
  });

  it("detects tracked local deletions", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addBlob("deleted");
    metadata.update("deleted.md", { sha, dirty: false, deleted: false }, 1);

    await expect(createManager(vault, github, metadata).hasLocalChanges()).resolves.toBe(true);
  });

  it("detects local empty folder marker changes", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFolder("empty");

    await expect(createManager(vault, github, metadata).hasLocalChanges()).resolves.toBe(true);
  });

  it("checks only queued local paths for incremental local change detection", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const unchangedSha = await github.addBlob("same");
    const editedSha = await github.addBlob("old");
    vault.addFile("same.md", "same");
    vault.addFile("edited.md", "new");
    metadata.update("same.md", { sha: unchangedSha, dirty: false, deleted: false }, 1);
    metadata.update("edited.md", { sha: editedSha, dirty: false, deleted: false }, 1);

    await expect(
      createManager(vault, github, metadata).hasLocalChangesForPaths(new Set(["same.md"])),
    ).resolves.toBe(false);
    await expect(
      createManager(vault, github, metadata).hasLocalChangesForPaths(new Set(["edited.md"])),
    ).resolves.toBe(true);
    expect(github.getRemoteCalls).toBe(0);
  });

  it("detects parent empty-folder changes during incremental local checks", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const fileSha = await github.addBlob("note");
    const file = vault.addFile("folder/note.md", "note");
    metadata.update("folder/note.md", { sha: fileSha, dirty: false, deleted: false }, 1);
    await vault.delete(file);

    await expect(
      createManager(vault, github, metadata).hasLocalChangesForPaths(new Set(["folder/note.md"])),
    ).resolves.toBe(true);
  });

  it("detects remote changes from GitHub tree state without hashing local files", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    await github.addRemoteFile("remote.md", "remote");

    await expect(createManager(vault, github, metadata).hasRemoteChanges()).resolves.toBe(true);
    expect(github.getRemoteCalls).toBe(1);
  });

  it("does not report remote changes when GitHub tree matches metadata", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addRemoteFile("remote.md", "remote");
    metadata.update("remote.md", { sha, dirty: false, deleted: false }, 1);

    await expect(createManager(vault, github, metadata).hasRemoteChanges()).resolves.toBe(false);
  });

  it("detects remote deletions and empty-folder marker changes", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    metadata.update("deleted.md", { sha: "old", dirty: false, deleted: false }, 1);
    await github.addRemoteFile("empty/.octosync-folder", "marker");

    await expect(createManager(vault, github, metadata).hasRemoteChanges()).resolves.toBe(true);
  });

  it("uploads local edits when remote still matches metadata", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addRemoteFile("note.md", "old");
    vault.addFile("note.md", "new");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.uploaded).toBe(1);
    expect(await github.readRemoteText("note.md")).toBe("new");
  });

  it("reports progress while applying sync changes", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("local.md", "local");
    await github.addRemoteFile("remote.md", "remote");
    const progress: Array<{ completed: number; total: number; operation: string; path: string }> = [];

    const summary = await createManager(vault, github, metadata).sync({
      onProgress: (event) => progress.push(event),
    });

    expect(summary.uploaded).toBe(1);
    expect(summary.downloaded).toBe(1);
    expect(progress).toEqual([
      expect.objectContaining({ completed: 1, total: 2, operation: "upload", path: "local.md" }),
      expect.objectContaining({ completed: 2, total: 2, operation: "download", path: "remote.md" }),
    ]);
  });

  it("downloads remote edits when local still matches metadata", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    vault.addFile("note.md", "old");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    await github.addRemoteFile("note.md", "new");

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.downloaded).toBe(1);
    expect(vault.readText("note.md")).toBe("new");
  });

  it("falls back to recreating an existing file when modifyBinary reports it already exists", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    vault.addFile("note.md", "old");
    vault.failNextModifyBinary = new Error("File already exists.");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    await github.addRemoteFile("note.md", "new");

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.downloaded).toBe(1);
    expect(vault.readText("note.md")).toBe("new");
  });

  it("deletes remote files when a tracked local file is removed", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addRemoteFile("note.md", "old");
    metadata.update("note.md", { sha, dirty: false, deleted: false }, 1);

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.deletedRemote).toBe(1);
    expect(github.remote.has("note.md")).toBe(false);
    expect(metadata.get("note.md")?.deleted).toBe(true);
  });

  it("deletes local files when a tracked remote file is removed", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addBlob("old");
    vault.addFile("note.md", "old");
    metadata.update("note.md", { sha, dirty: false, deleted: false }, 1);

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.deletedLocal).toBe(1);
    expect(vault.exists("note.md")).toBe(false);
    expect(metadata.get("note.md")?.deleted).toBe(true);
  });

  it("stops on file conflicts and does not commit tree changes", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    vault.addFile("note.md", "local");
    await github.addRemoteFile("note.md", "remote");

    await expect(createManager(vault, github, metadata).sync()).rejects.toEqual(
      expect.objectContaining({
        name: "SyncConflictError",
        conflicts: ["note.md"],
      }) as SyncConflictError,
    );
    expect(github.commits).toBe(0);
  });

  it("treats local edits against remote deletions as conflicts", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    vault.addFile("note.md", "local edit");

    await expect(createManager(vault, github, metadata).sync()).rejects.toMatchObject({
      name: "SyncConflictError",
      conflicts: ["note.md"],
    });
    expect(vault.readText("note.md")).toBe("local edit");
    expect(github.remote.has("note.md")).toBe(false);
  });

  it("treats local deletions against remote edits as conflicts", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    await github.addRemoteFile("note.md", "remote edit");

    await expect(createManager(vault, github, metadata).sync()).rejects.toMatchObject({
      name: "SyncConflictError",
      conflicts: ["note.md"],
    });
    expect(await github.readRemoteText("note.md")).toBe("remote edit");
    expect(metadata.get("note.md")?.sha).toBe(oldSha);
  });

  it("does not mutate non-conflicting files when another file conflicts", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    metadata.update("conflict.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    vault.addFile("conflict.md", "local");
    await github.addRemoteFile("conflict.md", "remote");
    await github.addRemoteFile("remote-only.md", "remote-only");

    await expect(createManager(vault, github, metadata).sync()).rejects.toMatchObject({
      name: "SyncConflictError",
      conflicts: ["conflict.md"],
    });
    expect(vault.exists("remote-only.md")).toBe(false);
    expect(metadata.get("remote-only.md")).toBeUndefined();
    expect(github.commits).toBe(0);
  });

  it("records both-sided deletions without reporting a conflict", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    metadata.update("deleted.md", { sha: "old-sha", dirty: false, deleted: false }, 1);

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.conflicts).toEqual([]);
    expect(metadata.get("deleted.md")).toMatchObject({
      sha: null,
      deleted: true,
    });
  });

  it("uploads empty local folders as Octosync marker files", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFolder("empty");

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.foldersUploaded).toBe(1);
    expect(github.remote.has("empty/.octosync-folder")).toBe(true);
    expect(metadata.getFolder("empty")?.markerSha).toBe(
      github.remote.get("empty/.octosync-folder")?.sha,
    );
  });

  it("does not upload an empty-folder marker after downloading a file into that folder", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFolder("folder");
    await github.addRemoteFile("folder/remote.md", "remote");

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.downloaded).toBe(1);
    expect(summary.foldersUploaded).toBe(0);
    expect(vault.readText("folder/remote.md")).toBe("remote");
    expect(github.remote.has("folder/.octosync-folder")).toBe(false);
  });

  it("downloads remote empty folder markers as local folders", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    await github.addRemoteFile(
      "empty/.octosync-folder",
      "Octosync placeholder for an empty Obsidian folder.\n",
    );

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.foldersDownloaded).toBe(1);
    expect(vault.exists("empty")).toBe(true);
    expect(metadata.getFolder("empty")?.markerSha).toBe(
      github.remote.get("empty/.octosync-folder")?.sha,
    );
  });

  it("retries non-fast-forward commits against the latest remote state", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("note.md", "local");
    github.failNextUpdateRef = new GitHubRequestError("Update is not a fast-forward", 422);

    const summary = await createManager(vault, github, metadata).sync();

    expect(summary.uploaded).toBe(1);
    expect(github.updateRefAttempts).toBe(2);
    expect(await github.readRemoteText("note.md")).toBe("local");
  });

  it("does not apply prepared local downloads when the remote commit fails", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("local.md", "local");
    await github.addRemoteFile("remote.md", "remote");
    github.failNextUpdateRef = new GitHubRequestError("server error", 500);

    await expect(createManager(vault, github, metadata).sync()).rejects.toThrow("server error");

    expect(github.remote.has("local.md")).toBe(false);
    expect(vault.exists("remote.md")).toBe(false);
    expect(metadata.get("local.md")).toBeUndefined();
    expect(metadata.get("remote.md")).toBeUndefined();
  });

  it("does not overwrite a path changed remotely during non-fast-forward retry", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addRemoteFile("note.md", "old");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    vault.addFile("note.md", "local");
    github.failNextUpdateRef = new GitHubRequestError("Update is not a fast-forward", 422);
    github.beforeFailNextUpdateRef = async () => {
      await github.addRemoteFile("note.md", "remote changed during retry");
    };

    await expect(createManager(vault, github, metadata).sync()).rejects.toThrow(
      "Remote changed note.md during sync",
    );
    expect(await github.readRemoteText("note.md")).toBe("remote changed during retry");
    expect(metadata.get("note.md")?.sha).toBe(oldSha);
  });

  it("keeps a local conflict copy when resolving local-edit remote-delete conflicts as both", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    metadata.update("note.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    vault.addFile("note.md", "local edit");

    const summary = await createManager(vault, github, metadata).resolveConflicts(
      ["note.md"],
      "both",
    );

    const conflictPath = vault
      .getFiles()
      .map((file) => file.path)
      .find((path) => path.startsWith("note.local-conflict-"));
    expect(summary.uploaded).toBe(1);
    expect(summary.deletedLocal).toBe(1);
    expect(vault.exists("note.md")).toBe(false);
    expect(conflictPath).toBeDefined();
    expect(vault.readText(conflictPath!)).toBe("local edit");
    expect(await github.readRemoteText(conflictPath!)).toBe("local edit");
  });
});

class MemoryVault {
  private readonly files = new Map<string, { file: TFile; bytes: Uint8Array }>();
  private readonly folders = new Map<string, TFolder>();
  readonly configDir = ".obsidian";
  failNextModifyBinary: Error | null = null;

  getFiles(): TFile[] {
    return Array.from(this.files.values()).map((entry) => entry.file);
  }

  getAllLoadedFiles(): Array<TFile | TFolder> {
    return [...this.folders.values(), ...this.getFiles()];
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const entry = this.files.get(file.path);
    if (!entry) {
      throw new Error(`Missing file ${file.path}`);
    }

    return cloneBuffer(entry.bytes);
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  async modifyBinary(file: TFile, bytes: ArrayBuffer): Promise<void> {
    if (this.failNextModifyBinary) {
      const error = this.failNextModifyBinary;
      this.failNextModifyBinary = null;
      throw error;
    }

    this.files.set(file.path, { file, bytes: new Uint8Array(bytes.slice(0)) });
  }

  async createBinary(path: string, bytes: ArrayBuffer): Promise<TFile> {
    const parentPath = parentFolder(path);
    if (parentPath) {
      this.addFolder(parentPath);
    }

    const file = new TFile(path);
    this.files.set(path, { file, bytes: new Uint8Array(bytes.slice(0)) });
    this.addChild(file);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    return this.addFolder(path);
  }

  async delete(file: TFile | TFolder): Promise<void> {
    if (file instanceof TFile) {
      this.files.delete(file.path);
      this.removeChild(file);
      return;
    }

    this.folders.delete(file.path);
    this.removeChild(file);
  }

  addFile(path: string, content: string): TFile {
    const bytes = new TextEncoder().encode(content);
    const parentPath = parentFolder(path);
    if (parentPath) {
      this.addFolder(parentPath);
    }

    const file = new TFile(path);
    this.files.set(path, { file, bytes });
    this.addChild(file);
    return file;
  }

  addFolder(path: string): TFolder {
    const existing = this.folders.get(path);
    if (existing) {
      return existing;
    }

    const parentPath = parentFolder(path);
    if (parentPath) {
      this.addFolder(parentPath);
    }

    const folder = new TFolder(path);
    this.folders.set(path, folder);
    this.addChild(folder);
    return folder;
  }

  readText(path: string): string {
    const entry = this.files.get(path);
    if (!entry) {
      throw new Error(`Missing file ${path}`);
    }

    return new TextDecoder().decode(entry.bytes);
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.folders.has(path);
  }

  private addChild(child: TFile | TFolder): void {
    const parentPath = parentFolder(child.path);
    if (!parentPath) {
      return;
    }

    const parent = this.folders.get(parentPath);
    if (!parent || parent.children.some((existing) => existing.path === child.path)) {
      return;
    }

    parent.children.push(child);
  }

  private removeChild(child: TFile | TFolder): void {
    const parentPath = parentFolder(child.path);
    if (!parentPath) {
      return;
    }

    const parent = this.folders.get(parentPath);
    if (parent) {
      parent.children = parent.children.filter((existing) => existing.path !== child.path);
    }
  }
}

class MockGitHubClient {
  static nextCommit = 1;
  readonly blobs = new Map<string, Uint8Array>();
  readonly remote = new Map<string, RemoteFile>();
  commits = 0;
  updateRefAttempts = 0;
  getRemoteCalls = 0;
  failNextUpdateRef: Error | null = null;
  beforeFailNextUpdateRef: (() => Promise<void> | void) | null = null;
  private pendingUpdates: Array<{ path: string; sha: string | null }> = [];

  static reset(): void {
    MockGitHubClient.nextCommit = 1;
  }

  async addBlob(content: string): Promise<string> {
    const bytes = new TextEncoder().encode(content);
    const sha = await gitBlobSha(cloneBuffer(bytes));
    this.blobs.set(sha, bytes);
    return sha;
  }

  async addRemoteFile(path: string, content: string): Promise<string> {
    const sha = await this.addBlob(content);
    this.remote.set(path, { path, sha, size: content.length });
    return sha;
  }

  async readRemoteText(path: string): Promise<string> {
    const file = this.remote.get(path);
    if (!file) {
      throw new Error(`Missing remote file ${path}`);
    }

    const bytes = this.blobs.get(file.sha);
    if (!bytes) {
      throw new Error(`Missing blob ${file.sha}`);
    }

    return new TextDecoder().decode(bytes);
  }

  async getRemoteFiles(): Promise<{
    commitSha: string;
    treeSha: string;
    files: Map<string, RemoteFile>;
  }> {
    this.getRemoteCalls += 1;
    return {
      commitSha: `commit-${MockGitHubClient.nextCommit}`,
      treeSha: `tree-${MockGitHubClient.nextCommit}`,
      files: new Map(this.remote),
    };
  }

  async getBlob(_owner: string, _repo: string, sha: string): Promise<{
    sha: string;
    content: string;
    encoding: "base64";
  }> {
    const bytes = this.blobs.get(sha);
    if (!bytes) {
      throw new Error(`Missing blob ${sha}`);
    }

    return {
      sha,
      content: bytesToBase64(cloneBuffer(bytes)),
      encoding: "base64",
    };
  }

  async createBlob(_owner: string, _repo: string, contentBase64: string): Promise<{ sha: string }> {
    const bytes = new Uint8Array(base64ToBytes(contentBase64));
    const sha = await gitBlobSha(cloneBuffer(bytes));
    this.blobs.set(sha, bytes);
    return { sha };
  }

  async createTree(
    _owner: string,
    _repo: string,
    _baseTreeSha: string,
    tree: Array<{ path: string; sha: string | null }>,
  ): Promise<{ sha: string }> {
    this.pendingUpdates = tree.map(({ path, sha }) => ({ path, sha }));
    return { sha: `tree-new-${MockGitHubClient.nextCommit}` };
  }

  async createCommit(): Promise<{ sha: string }> {
    this.commits += 1;
    MockGitHubClient.nextCommit += 1;
    return { sha: `commit-${MockGitHubClient.nextCommit}` };
  }

  async updateBranchRef(): Promise<void> {
    this.updateRefAttempts += 1;
    if (this.failNextUpdateRef) {
      const error = this.failNextUpdateRef;
      this.failNextUpdateRef = null;
      await this.beforeFailNextUpdateRef?.();
      this.beforeFailNextUpdateRef = null;
      throw error;
    }

    for (const update of this.pendingUpdates) {
      if (update.sha === null) {
        this.remote.delete(update.path);
        continue;
      }

      const bytes = this.blobs.get(update.sha);
      this.remote.set(update.path, {
        path: update.path,
        sha: update.sha,
        size: bytes?.byteLength ?? 0,
      });
    }
    this.pendingUpdates = [];
  }
}

async function createMetadata(): Promise<MetadataStore> {
  const metadata = new MetadataStore(async () => null, async () => {});
  await metadata.load();
  return metadata;
}

function createManager(
  vault: MemoryVault,
  github: MockGitHubClient,
  metadata: MetadataStore,
): SyncManager {
  return new SyncManager(
    vault as never,
    { trashFile: (file: TFile | TFolder) => vault.delete(file) } as never,
    github as unknown as GitHubClient,
    metadata,
    settings,
    undefined,
  );
}

function cloneBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function parentFolder(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex === -1 ? "" : path.slice(0, slashIndex);
}

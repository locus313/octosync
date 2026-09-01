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
  getValidExtraHiddenDirs,
  getValidVaultExcludePaths,
  hasUserVisibleSyncChanges,
  isValidExtraHiddenDir,
  isVaultPathExcluded,
  matchesExcludePattern,
  normalizeVaultExcludePath,
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
      excluded: 0,
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
        excluded: 0,
        conflicts: ["note.md"],
      }),
    ).toBe(
      "1 uploaded, 2 downloaded, 3 local deletions, 4 remote deletions, 5 folders uploaded, 6 folders downloaded, 7 local folder deletions, 8 remote folder deletions, 1 conflicts",
    );
  });

  it("reports device-local exclusions without treating them as sync changes", () => {
    const summary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      foldersUploaded: 0,
      foldersDownloaded: 0,
      foldersDeletedLocal: 0,
      foldersDeletedRemote: 0,
      excluded: 2,
      conflicts: [],
    };

    expect(hasUserVisibleSyncChanges(summary)).toBe(false);
    expect(formatSummary(summary)).toBe(
      "No sync required. Everything is up to date. 2 device-local paths excluded.",
    );
  });

  it("ignores the configured Obsidian config folder, Git, trash, Octosync, marker, and reserved files", () => {
    expect(shouldIgnorePath(".git/config", ".custom-obsidian")).toBe(true);
    expect(shouldIgnorePath(".custom-obsidian/workspace.json", ".custom-obsidian")).toBe(true);
    // .obsidian is a hidden dir and not configDir here, so it is blocked unless opted in
    expect(shouldIgnorePath(".obsidian/workspace.json", ".custom-obsidian")).toBe(true);
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
    const allowed = [".obsidian/community-plugins.json", ".obsidian/themes"];

    // Allowed paths should not be ignored
    expect(shouldIgnorePath(".obsidian/community-plugins.json", configDir, allowed)).toBe(false);
    expect(shouldIgnorePath(".obsidian/themes", configDir, allowed)).toBe(false);
    expect(shouldIgnorePath(".obsidian/themes/my-theme/theme.css", configDir, allowed)).toBe(false);

    // Non-allowed config paths are still ignored
    expect(shouldIgnorePath(".obsidian/workspace.json", configDir, allowed)).toBe(true);
    expect(shouldIgnorePath(".obsidian/app.json", configDir, allowed)).toBe(true);
    expect(shouldIgnorePath(".obsidian/plugins/some-plugin/data.json", configDir, allowed)).toBe(true);

    // Reserved filenames and Octosync markers are ignored even inside allowed config paths
    expect(shouldIgnorePath(".obsidian/themes/foo/.octosync-folder", configDir, allowed)).toBe(true);
    expect(shouldIgnorePath(".obsidian/themes/foo/.DS_Store", configDir, allowed)).toBe(true);
    expect(shouldIgnorePath(".obsidian/community-plugins.json", configDir, allowed)).toBe(false);
  });

  it("respects user-defined exclude patterns via shouldIgnorePath", () => {
    const configDir = ".obsidian";
    const allowed = getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncThemes: true }, configDir);

    // Path-prefix pattern excludes a specific theme folder
    const excludeByPath = [".obsidian/themes/my-theme"];
    expect(shouldIgnorePath(".obsidian/themes/my-theme/theme.css", configDir, allowed, excludeByPath)).toBe(true);
    expect(shouldIgnorePath(".obsidian/themes/my-theme", configDir, allowed, excludeByPath)).toBe(true);
    expect(shouldIgnorePath(".obsidian/themes/other-theme/theme.css", configDir, allowed, excludeByPath)).toBe(false);

    // Filename-only pattern matches within synced config paths
    const excludeByName = ["theme.css"];
    expect(shouldIgnorePath(".obsidian/themes/my-theme/theme.css", configDir, allowed, excludeByName)).toBe(true);
    expect(shouldIgnorePath(".obsidian/themes/my-theme/manifest.json", configDir, allowed, excludeByName)).toBe(false);
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

  it("blocks unknown top-level hidden dirs but allows configured extra hidden dirs", () => {
    const configDir = ".obsidian";

    // Hidden dir not in extraHiddenDirs → ignored
    expect(shouldIgnorePath(".copilot/skills/test.md", configDir, [], [], [])).toBe(true);
    expect(shouldIgnorePath(".claude/CLAUDE.md", configDir, [], [], [])).toBe(true);

    // Hidden dir in extraHiddenDirs → not ignored
    expect(shouldIgnorePath(".copilot/skills/test.md", configDir, [], [], [".copilot"])).toBe(false);
    expect(shouldIgnorePath(".claude/CLAUDE.md", configDir, [], [], [".copilot", ".claude"])).toBe(false);

    // Nested path inside configured extra hidden dir → not ignored
    expect(shouldIgnorePath(".copilot/skills/sub/deep.md", configDir, [], [], [".copilot"])).toBe(false);

    // Reserved filenames inside extra hidden dirs are still excluded
    expect(shouldIgnorePath(".copilot/.DS_Store", configDir, [], [], [".copilot"])).toBe(true);
    expect(shouldIgnorePath(".copilot/empty/.octosync-folder", configDir, [], [], [".copilot"])).toBe(true);

    // Exclude patterns apply inside extra hidden dirs
    expect(shouldIgnorePath(".copilot/secrets.json", configDir, [], [".copilot/secrets.json"], [".copilot"])).toBe(true);

    // Top-level hidden file (no slash) is still matched by RESERVED_FILES, not the hidden-dir check
    expect(shouldIgnorePath(".gitignore", configDir, [], [], [])).toBe(true);

    // Reserved dirs (.git, .trash, .octosync) are always blocked even if listed in extraHiddenDirs
    expect(shouldIgnorePath(".git/config", configDir, [], [], [".git"])).toBe(true);
    expect(shouldIgnorePath(".trash/deleted.md", configDir, [], [], [".trash"])).toBe(true);
    expect(shouldIgnorePath(".octosync/state.json", configDir, [], [], [".octosync"])).toBe(true);
  });

  it("isValidExtraHiddenDir accepts simple hidden names and rejects reserved/invalid entries", () => {
    // Valid
    expect(isValidExtraHiddenDir(".copilot")).toBe(true);
    expect(isValidExtraHiddenDir(".claude")).toBe(true);
    expect(isValidExtraHiddenDir(".codex")).toBe(true);

    // Reserved names
    expect(isValidExtraHiddenDir(".git")).toBe(false);
    expect(isValidExtraHiddenDir(".trash")).toBe(false);
    expect(isValidExtraHiddenDir(".octosync")).toBe(false);

    // Nested paths not allowed
    expect(isValidExtraHiddenDir(".copilot/skills")).toBe(false);
    expect(isValidExtraHiddenDir(".a/b")).toBe(false);

    // Must start with dot and have at least one character after it
    expect(isValidExtraHiddenDir("copilot")).toBe(false);
    expect(isValidExtraHiddenDir(".")).toBe(false);
    expect(isValidExtraHiddenDir("")).toBe(false);

    // Parent-directory traversal must be rejected explicitly
    expect(isValidExtraHiddenDir("..")).toBe(false);
  });

  it("getValidExtraHiddenDirs sanitizes tampered or manually-edited persisted settings", () => {
    const dirtySettings: OctosyncSettings = {
      ...DEFAULT_SETTINGS,
      syncExtraHiddenDirs: [".copilot", "..", ".git", ".claude/skills", "not-hidden", ".claude"],
    };

    expect(getValidExtraHiddenDirs(dirtySettings)).toEqual([".copilot", ".claude"]);
  });

  it("normalizes safe device-local exclusions and rejects traversal or absolute paths", () => {
    expect(normalizeVaultExcludePath(" Personal/Private/ ")).toBe("Personal/Private");
    expect(normalizeVaultExcludePath("Work\\Private")).toBe("Work/Private");
    expect(normalizeVaultExcludePath("/Personal")).toBeNull();
    expect(normalizeVaultExcludePath("../Personal")).toBeNull();
    expect(normalizeVaultExcludePath("Personal/../Work")).toBeNull();
    expect(normalizeVaultExcludePath("Personal//Private")).toBeNull();
  });

  it("deduplicates device-local exclusions and removes redundant descendants", () => {
    const dirtySettings = {
      ...DEFAULT_SETTINGS,
      syncVaultExcludePaths: [
        "Personal/Private",
        "Personal",
        "Work\\Private",
        "Work/Private/",
        "../outside",
      ],
    };

    expect(getValidVaultExcludePaths(dirtySettings)).toEqual(["Personal", "Work/Private"]);
  });

  it("matches device-local exclusions by path boundary", () => {
    const exclusions = ["Personal", "Archive/Private"];

    expect(isVaultPathExcluded("Personal", exclusions)).toBe(true);
    expect(isVaultPathExcluded("Personal/Journal/note.md", exclusions)).toBe(true);
    expect(isVaultPathExcluded("Archive/Private/note.md", exclusions)).toBe(true);
    expect(isVaultPathExcluded("Personality/note.md", exclusions)).toBe(false);
    expect(isVaultPathExcluded("Archive/Privateer/note.md", exclusions)).toBe(false);
    expect(shouldIgnorePath("Personal/note.md", ".obsidian", [], [], [], exclusions)).toBe(true);
    expect(shouldIgnorePath("Work/note.md", ".obsidian", [], [], [], exclusions)).toBe(false);
  });

  it("getConfigAllowedPaths returns correct paths based on settings", () => {
    const configDir = ".obsidian";

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: false, syncThemes: false, syncSnippets: false }, configDir),
    ).toEqual([]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: true }, configDir),
    ).toEqual([".obsidian/community-plugins.json"]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncThemes: true }, configDir),
    ).toEqual([".obsidian/themes"]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncSnippets: true }, configDir),
    ).toEqual([".obsidian/snippets"]);

    expect(
      getConfigAllowedPaths({ ...DEFAULT_SETTINGS, syncCommunityPlugins: true, syncThemes: true, syncSnippets: true }, configDir),
    ).toEqual([".obsidian/community-plugins.json", ".obsidian/themes", ".obsidian/snippets"]);
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

  it("syncs allowed config-dir files when the corresponding setting is enabled", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();

    vault.addFile("note.md", "vault note");
    vault.addFile(".obsidian/community-plugins.json", '["dataview"]');
    vault.addFile(".obsidian/themes/my-theme/theme.css", "body { color: red; }");
    vault.addFile(".obsidian/snippets/custom.css", ".highlight { background: yellow; }");
    vault.addFile(".obsidian/workspace.json", '{"main":{"id":"main"}}');

    const syncSettings = {
      ...settings,
      syncCommunityPlugins: true,
      syncThemes: true,
      syncSnippets: true,
    };
    const manager = new SyncManager(
      vault as never,
      { trashFile: (file: TFile | TFolder) => vault.delete(file) } as never,
      github as unknown as GitHubClient,
      metadata,
      syncSettings,
      undefined,
    );
    const summary = await manager.sync();

    // vault note + community-plugins.json + theme + snippet = 4 uploads
    expect(summary.uploaded).toBe(4);
    expect(await github.readRemoteText("note.md")).toBe("vault note");
    expect(await github.readRemoteText(".obsidian/community-plugins.json")).toBe('["dataview"]');
    expect(await github.readRemoteText(".obsidian/themes/my-theme/theme.css")).toBe("body { color: red; }");
    expect(await github.readRemoteText(".obsidian/snippets/custom.css")).toBe(".highlight { background: yellow; }");
    // workspace.json is not in the allow-list and must not have synced
    expect(github.remote.has(".obsidian/workspace.json")).toBe(false);
  });

  it("downloads allowed config-dir files through the adapter", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();

    const themeSha = await github.addRemoteFile(".obsidian/themes/my-theme/theme.css", "body { color: blue; }");
    await github.addRemoteFile(".obsidian/workspace.json", "{\"main\":{\"id\":\"main\"}}");

    const syncSettings = {
      ...settings,
      syncThemes: true,
    };
    const manager = new SyncManager(
      vault as never,
      { trashFile: (file: TFile | TFolder) => vault.delete(file) } as never,
      github as unknown as GitHubClient,
      metadata,
      syncSettings,
      undefined,
    );
    const summary = await manager.sync();

    expect(summary.downloaded).toBe(1);
    expect(vault.readText(".obsidian/themes/my-theme/theme.css")).toBe("body { color: blue; }");
    expect(metadata.get(".obsidian/themes/my-theme/theme.css")?.sha).toBe(themeSha);
    expect(vault.exists(".obsidian/workspace.json")).toBe(false);
    expect(vault.getFiles().some((file) => file.path.startsWith(".obsidian/"))).toBe(false);
  });

  it("uploads local extra hidden dir files through the adapter", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();

    vault.addFile("note.md", "vault note");
    vault.addFile(".copilot/skills/SKILL.md", "# My skill");
    vault.addFile(".claude/CLAUDE.md", "# Claude config");
    vault.addFile(".other-hidden/file.md", "should not sync");

    const syncSettings = {
      ...settings,
      syncExtraHiddenDirs: [".copilot", ".claude"],
    };
    const manager = new SyncManager(
      vault as never,
      { trashFile: (file: TFile | TFolder) => vault.delete(file) } as never,
      github as unknown as GitHubClient,
      metadata,
      syncSettings,
      undefined,
    );
    const summary = await manager.sync();

    // note + .copilot/skills/SKILL.md + .claude/CLAUDE.md = 3 uploads
    expect(summary.uploaded).toBe(3);
    expect(await github.readRemoteText(".copilot/skills/SKILL.md")).toBe("# My skill");
    expect(await github.readRemoteText(".claude/CLAUDE.md")).toBe("# Claude config");
    // .other-hidden is not configured and must not have synced
    expect(github.remote.has(".other-hidden/file.md")).toBe(false);
    // extra hidden dir files must not appear in vault.getFiles()
    expect(vault.getFiles().some((f) => f.path.startsWith("."))).toBe(false);
  });

  it("downloads remote extra hidden dir files through the adapter", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();

    const skillSha = await github.addRemoteFile(".copilot/skills/SKILL.md", "# Remote skill");
    await github.addRemoteFile(".other-hidden/ignore.md", "should not download");

    const syncSettings = {
      ...settings,
      syncExtraHiddenDirs: [".copilot"],
    };
    const manager = new SyncManager(
      vault as never,
      { trashFile: (file: TFile | TFolder) => vault.delete(file) } as never,
      github as unknown as GitHubClient,
      metadata,
      syncSettings,
      undefined,
    );
    const summary = await manager.sync();

    expect(summary.downloaded).toBe(1);
    expect(vault.readText(".copilot/skills/SKILL.md")).toBe("# Remote skill");
    expect(metadata.get(".copilot/skills/SKILL.md")?.sha).toBe(skillSha);
    // .other-hidden is not configured and must not be downloaded
    expect(vault.exists(".other-hidden/ignore.md")).toBe(false);
  });

  it("ignores a tampered '..' entry in syncExtraHiddenDirs instead of treating it as an adapter path", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();

    // Settings bypassing the settings-tab UI validation (e.g. manually edited plugin data).
    await github.addRemoteFile("../outside-vault.md", "should never be written");

    const syncSettings = {
      ...settings,
      syncExtraHiddenDirs: [".."],
    };
    const manager = new SyncManager(
      vault as never,
      { trashFile: (file: TFile | TFolder) => vault.delete(file) } as never,
      github as unknown as GitHubClient,
      metadata,
      syncSettings,
      undefined,
    );
    const summary = await manager.sync();

    expect(summary.downloaded).toBe(0);
    expect(vault.exists("../outside-vault.md")).toBe(false);
  });

  it("keeps device-local excluded files out of uploads and downloads", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("Personal/local-only.md", "local private");
    vault.addFile("Work/local.md", "local work");
    await github.addRemoteFile("Personal/remote-only.md", "remote private");
    await github.addRemoteFile("Work/remote.md", "remote work");

    const summary = await createManager(vault, github, metadata, {
      syncVaultExcludePaths: ["Personal"],
    }).sync();

    expect(summary).toMatchObject({ uploaded: 1, downloaded: 1, excluded: 2, conflicts: [] });
    expect(github.remote.has("Personal/local-only.md")).toBe(false);
    expect(vault.exists("Personal/remote-only.md")).toBe(false);
    expect(await github.readRemoteText("Personal/remote-only.md")).toBe("remote private");
    expect(await github.readRemoteText("Work/local.md")).toBe("local work");
    expect(vault.readText("Work/remote.md")).toBe("remote work");
  });

  it("never turns a missing excluded local file into a remote deletion", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addRemoteFile("Personal/private.md", "keep remotely");
    metadata.update("Personal/private.md", { sha, dirty: false, deleted: false }, 1);
    const manager = createManager(vault, github, metadata, {
      syncVaultExcludePaths: ["Personal"],
    });

    expect(await manager.hasLocalChanges()).toBe(false);
    expect(await manager.hasRemoteChanges()).toBe(false);
    const summary = await manager.sync();

    expect(summary).toMatchObject({ deletedRemote: 0, excluded: 1, conflicts: [] });
    expect(await github.readRemoteText("Personal/private.md")).toBe("keep remotely");
    expect(github.commits).toBe(0);
  });

  it("does not light change indicators for new files that exist only inside exclusions", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("Personal/local-only.md", "local private");
    await github.addRemoteFile("Personal/remote-only.md", "remote private");
    const manager = createManager(vault, github, metadata, {
      syncVaultExcludePaths: ["Personal"],
    });

    expect(await manager.hasLocalChanges()).toBe(false);
    expect(await manager.hasLocalChangesForPaths(new Set(["Personal/local-only.md"]))).toBe(false);
    expect(await manager.hasRemoteChanges()).toBe(false);
  });

  it("never turns a missing excluded remote file into a local deletion", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addBlob("keep locally");
    vault.addFile("Personal/private.md", "keep locally");
    metadata.update("Personal/private.md", { sha, dirty: false, deleted: false }, 1);

    const summary = await createManager(vault, github, metadata, {
      syncVaultExcludePaths: ["Personal"],
    }).sync();

    expect(summary).toMatchObject({ deletedLocal: 0, excluded: 1, conflicts: [] });
    expect(vault.readText("Personal/private.md")).toBe("keep locally");
  });

  it("does not report or resolve conflicts inside device-local exclusions", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const oldSha = await github.addBlob("old");
    metadata.update("Personal/private.md", { sha: oldSha, dirty: false, deleted: false }, 1);
    vault.addFile("Personal/private.md", "local edit");
    await github.addRemoteFile("Personal/private.md", "remote edit");
    const manager = createManager(vault, github, metadata, {
      syncVaultExcludePaths: ["Personal"],
    });

    const plan = await manager.planSync();
    const resolution = await manager.resolveConflicts(["Personal/private.md"], "local");

    expect(plan).toMatchObject({ excluded: 1, conflicts: [] });
    expect(resolution).toMatchObject({ uploaded: 0, deletedRemote: 0, excluded: 1 });
    expect(vault.readText("Personal/private.md")).toBe("local edit");
    expect(await github.readRemoteText("Personal/private.md")).toBe("remote edit");
    expect(github.commits).toBe(0);
  });

  it("does not materialize excluded remote empty folders", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFolder("Personal/Empty");
    await github.addRemoteFile(
      "Personal/Empty/.octosync-folder",
      "Octosync placeholder for an empty Obsidian folder.\n",
    );

    const summary = await createManager(vault, github, metadata, {
      syncVaultExcludePaths: ["Personal"],
    }).sync();

    expect(summary).toMatchObject({ foldersUploaded: 0, foldersDownloaded: 0, excluded: 1 });
    expect(vault.exists("Personal/Empty")).toBe(true);
    expect(github.remote.has("Personal/Empty/.octosync-folder")).toBe(true);
  });

  it("does not treat an included parent containing only excluded content as an empty folder", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    vault.addFile("Work/Personal/private.md", "private");

    const summary = await createManager(vault, github, metadata, {
      syncVaultExcludePaths: ["Work/Personal"],
    }).sync();

    expect(summary).toMatchObject({ uploaded: 0, foldersUploaded: 0, excluded: 1 });
    expect(github.remote.has("Work/.octosync-folder")).toBe(false);
    expect(github.remote.has("Work/Personal/private.md")).toBe(false);
  });

  it("downloads rather than deletes remote content after exclusion metadata is pruned and the path is re-enabled", async () => {
    const vault = new MemoryVault();
    const github = new MockGitHubClient();
    const metadata = await createMetadata();
    const sha = await github.addRemoteFile("Personal/private.md", "restore me");
    metadata.update("Personal/private.md", { sha, dirty: false, deleted: false }, 1);

    expect(
      metadata.prunePaths((path) => isVaultPathExcluded(path, ["Personal"])),
    ).toEqual({ files: 1, folders: 0 });
    const summary = await createManager(vault, github, metadata).sync();

    expect(summary).toMatchObject({ downloaded: 1, deletedRemote: 0, conflicts: [] });
    expect(vault.readText("Personal/private.md")).toBe("restore me");
    expect(await github.readRemoteText("Personal/private.md")).toBe("restore me");
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

  // Mirrors real Obsidian behaviour: vault.getFiles() does not return files inside
  // any hidden top-level directory (including the config directory). Those paths are
  // only accessible via the adapter.
  getFiles(): TFile[] {
    return Array.from(this.files.values())
      .filter((entry) => !entry.file.path.split("/")[0].startsWith("."))
      .map((entry) => entry.file);
  }

  getAllLoadedFiles(): Array<TFile | TFolder> {
    return [...this.folders.values(), ...this.getFiles()];
  }

  readonly adapter = {
    stat: async (path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> => {
      if (this.files.has(path)) return { type: "file", ctime: 0, mtime: 0, size: this.files.get(path)!.bytes.length };
      if (this.folders.has(path)) return { type: "folder", ctime: 0, mtime: 0, size: 0 };
      return null;
    },
    list: async (path: string): Promise<{ files: string[]; folders: string[] }> => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const files: string[] = [];
      const folders: string[] = [];
      for (const filePath of this.files.keys()) {
        if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) {
          files.push(filePath);
        }
      }
      for (const folderPath of this.folders.keys()) {
        if (folderPath.startsWith(prefix) && !folderPath.slice(prefix.length).includes("/")) {
          folders.push(folderPath);
        }
      }
      return { files, folders };
    },
    readBinary: async (path: string): Promise<ArrayBuffer> => {
      const entry = this.files.get(path);
      if (!entry) throw new Error(`Missing file ${path}`);
      return cloneBuffer(entry.bytes);
    },
    writeBinary: async (path: string, bytes: ArrayBuffer): Promise<void> => {
      const existing = this.files.get(path);
      if (existing) {
        this.files.set(path, { file: existing.file, bytes: new Uint8Array(bytes.slice(0)) });
      } else {
        const file = new TFile(path);
        this.files.set(path, { file, bytes: new Uint8Array(bytes.slice(0)) });
        this.addChild(file);
      }
    },
    exists: async (path: string): Promise<boolean> => {
      return this.files.has(path) || this.folders.has(path);
    },
    mkdir: async (path: string): Promise<void> => {
      this.addFolder(path);
    },
    remove: async (path: string): Promise<void> => {
      const entry = this.files.get(path);
      if (entry) {
        this.files.delete(path);
        this.removeChild(entry.file);
      }
    },
  };

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
  overrides: Partial<OctosyncSettings> = {},
): SyncManager {
  return new SyncManager(
    vault as never,
    { trashFile: (file: TFile | TFolder) => vault.delete(file) } as never,
    github as unknown as GitHubClient,
    metadata,
    { ...settings, ...overrides },
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

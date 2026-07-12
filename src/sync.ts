import { FileManager, Notice, TFile, TFolder, Vault } from "obsidian";
import { GitHubClient, GitHubRequestError } from "./github";
import { base64ToBytes, bytesToBase64, gitBlobSha } from "./hash";
import { MetadataStore } from "./metadata";
import type { OctosyncSettings, RemoteFile, SyncMetadata, SyncSummary } from "./types";
import type { DebugLogSink } from "./debug-log";

const RESERVED_PREFIXES = [
  ".git/",
  ".trash/",
  ".octosync/",
];

const RESERVED_FILES = new Set([
  ".gitignore",
  ".DS_Store",
]);

const EMPTY_FOLDER_MARKER_NAME = ".octosync-folder";
const EMPTY_FOLDER_MARKER_CONTENT = "Octosync placeholder for an empty Obsidian folder.\n";

interface LocalFileSnapshot {
  file: TFile;
  path: string;
  sha: string;
  bytes: ArrayBuffer;
}

interface RemoteState {
  commitSha: string;
  treeSha: string;
  files: Map<string, RemoteFile>;
}

interface SyncPlan {
  remote: RemoteState;
  summary: SyncSummary;
  fileActions: FilePlanAction[];
  folderActions: FolderPlanAction[];
}

export interface SyncProgress {
  completed: number;
  total: number;
  operation:
    | "upload"
    | "download"
    | "deleteRemote"
    | "deleteLocal"
    | "uploadFolder"
    | "downloadFolder"
    | "deleteRemoteFolder"
    | "deleteLocalFolder";
  path: string;
}

export interface SyncExecutionOptions {
  onProgress?: (progress: SyncProgress) => void;
}

type FilePlanAction =
  | { type: "upload"; path: string; file: LocalFileSnapshot; blobSha?: string }
  | { type: "download"; path: string; sha: string }
  | { type: "deleteRemote"; path: string }
  | { type: "deleteLocal"; path: string; file: TFile }
  | { type: "metadata"; path: string; sha: string | null; deleted: boolean };

type FolderPlanAction =
  | { type: "uploadMarker"; folderPath: string; markerPath: string; markerSha?: string }
  | { type: "downloadFolder"; folderPath: string; markerSha: string }
  | { type: "deleteRemoteMarker"; folderPath: string; markerPath: string }
  | { type: "deleteLocalFolder"; folderPath: string }
  | { type: "updateFolder"; folderPath: string; markerSha: string | null; deleted: boolean }
  | { type: "removeFolder"; folderPath: string };

type IgnorePath = (path: string) => boolean;

export class SyncManager {
  constructor(
    private readonly vault: Vault,
    private readonly fileManager: FileManager,
    private readonly github: GitHubClient,
    private readonly metadata: MetadataStore,
    private readonly settings: OctosyncSettings,
    private readonly debugLog?: DebugLogSink,
  ) {}

  async sync(options: SyncExecutionOptions = {}): Promise<SyncSummary> {
    const plan = await this.createSyncPlan();

    if (plan.summary.conflicts.length > 0) {
      this.debugLog?.("sync.conflict-detected", {
        count: plan.summary.conflicts.length,
        conflicts: plan.summary.conflicts,
      });
      throw new SyncConflictError(plan.summary.conflicts);
    }

    return this.executeSyncPlan(plan, options);
  }

  async syncWithConfirmation(
    confirmPlan: (summary: SyncSummary) => Promise<boolean>,
    options: SyncExecutionOptions = {},
  ): Promise<SyncSummary | null> {
    const plan = await this.createSyncPlan();

    if (plan.summary.conflicts.length > 0) {
      this.debugLog?.("sync.conflict-detected", {
        count: plan.summary.conflicts.length,
        conflicts: plan.summary.conflicts,
      });
      throw new SyncConflictError(plan.summary.conflicts);
    }

    if (hasUserVisibleSyncChanges(plan.summary) && !(await confirmPlan(plan.summary))) {
      return null;
    }

    return this.executeSyncPlan(plan, options);
  }

  async planSync(): Promise<SyncSummary> {
    const plan = await this.createSyncPlan();
    return plan.summary;
  }

  async hasLocalChanges(): Promise<boolean> {
    const local = await this.getLocalFiles();
    const localFolders = this.getLocalFolders();
    const localEmptyFolders = this.getLocalEmptyFolders();

    for (const [path, localFile] of local) {
      if (this.shouldIgnorePath(path)) {
        continue;
      }

      const record = this.metadata.get(path);

      if (!record || record.sha === null || localFile.sha !== record.sha) {
        return true;
      }
    }

    for (const [path, record] of Object.entries(this.metadata.data.files)) {
      if (this.shouldIgnorePath(path)) {
        continue;
      }

      if (record.sha !== null && !local.has(path)) {
        return true;
      }
    }

    for (const folderPath of localEmptyFolders) {
      if (!this.metadata.getFolder(folderPath)?.markerSha) {
        return true;
      }
    }

    for (const [folderPath, record] of Object.entries(this.metadata.data.folders)) {
      if (this.shouldIgnorePath(`${folderPath}/`)) {
        continue;
      }

      if (record.markerSha === null) {
        continue;
      }

      if (!localFolders.has(folderPath) || !localEmptyFolders.has(folderPath)) {
        return true;
      }
    }

    return false;
  }

  async hasLocalChangesForPaths(paths: Set<string>): Promise<boolean> {
    const filePaths = new Set<string>();
    const folderPaths = new Set<string>();

    for (const path of paths) {
      if (!path || this.shouldIgnorePath(path) || this.shouldIgnorePath(`${path}/`)) {
        continue;
      }

      filePaths.add(path);
      addParentFolders(path, folderPaths, this.shouldIgnorePath);

      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFolder) {
        folderPaths.add(path);
      }
    }

    for (const path of filePaths) {
      const localFile = await this.getLocalFile(path);
      const record = this.metadata.get(path);

      if (localFile && (!record || record.sha === null || localFile.sha !== record.sha)) {
        return true;
      }

      if (!localFile && record?.sha) {
        return true;
      }
    }

    for (const folderPath of folderPaths) {
      if (await this.hasLocalFolderChange(folderPath)) {
        return true;
      }
    }

    return false;
  }

  async hasRemoteChanges(): Promise<boolean> {
    this.validateSettings();

    const remote = await this.getRemoteState();

    for (const [path, remoteFile] of remote.files) {
      if (this.shouldIgnorePath(path)) {
        continue;
      }

      if (this.metadata.get(path)?.sha !== remoteFile.sha) {
        return true;
      }
    }

    for (const [path, record] of Object.entries(this.metadata.data.files)) {
      if (this.shouldIgnorePath(path)) {
        continue;
      }

      if (record.sha !== null && !remote.files.has(path)) {
        return true;
      }
    }

    const remoteEmptyFolders = getRemoteEmptyFolders(remote.files);

    for (const [folderPath, remoteMarker] of remoteEmptyFolders) {
      if (this.metadata.getFolder(folderPath)?.markerSha !== remoteMarker.sha) {
        return true;
      }
    }

    for (const [folderPath, record] of Object.entries(this.metadata.data.folders)) {
      if (this.shouldIgnorePath(`${folderPath}/`)) {
        continue;
      }

      if (record.markerSha !== null && !remoteEmptyFolders.has(folderPath)) {
        return true;
      }
    }

    return false;
  }

  private async createSyncPlan(): Promise<SyncPlan> {
    this.validateSettings();

    const remote = await this.getRemoteState();
    const local = await this.getLocalFiles();
    const summary = createEmptySummary();
    const fileActions: FilePlanAction[] = [];
    const allPaths = new Set<string>([
      ...local.keys(),
      ...remote.files.keys(),
      ...Object.keys(this.metadata.data.files),
    ]);
    this.debugLog?.("sync.scan", {
      localFiles: local.size,
      remoteFiles: remote.files.size,
      metadataFiles: Object.keys(this.metadata.data.files).length,
    });

    const localFolders = this.getLocalFolders();
    summary.conflicts = [
      ...findPathShapeConflicts(local, localFolders, remote.files, this.shouldIgnorePath),
      ...findFileConflicts(allPaths, local, remote.files, this.metadata, this.shouldIgnorePath),
    ];

    if (summary.conflicts.length > 0) {
      return {
        remote,
        summary,
        fileActions,
        folderActions: [],
      };
    }

    for (const path of allPaths) {
      if (this.shouldIgnorePath(path)) {
        continue;
      }

      const localFile = local.get(path);
      const remoteFile = remote.files.get(path);
      const record = this.metadata.get(path);
      const knownSha = record?.sha ?? null;

      if (localFile && remoteFile && localFile.sha === remoteFile.sha) {
        fileActions.push({ type: "metadata", path, sha: remoteFile.sha, deleted: false });
        continue;
      }

      const localChanged = localFile ? localFile.sha !== knownSha : knownSha !== null;
      const remoteChanged = remoteFile ? remoteFile.sha !== knownSha : knownSha !== null;

      if (localFile && !remoteFile && knownSha === null) {
        fileActions.push({ type: "upload", path, file: localFile });
        summary.uploaded += 1;
        continue;
      }

      if (!localFile && remoteFile && knownSha === null) {
        fileActions.push({ type: "download", path, sha: remoteFile.sha });
        summary.downloaded += 1;
        continue;
      }

      if (localFile && remoteFile && localChanged && !remoteChanged) {
        fileActions.push({ type: "upload", path, file: localFile });
        summary.uploaded += 1;
        continue;
      }

      if (localFile && remoteFile && !localChanged && remoteChanged) {
        fileActions.push({ type: "download", path, sha: remoteFile.sha });
        summary.downloaded += 1;
        continue;
      }

      if (!localFile && remoteFile && !remoteChanged) {
        fileActions.push({ type: "deleteRemote", path });
        summary.deletedRemote += 1;
        continue;
      }

      if (localFile && !remoteFile && !localChanged) {
        if (isLocalConflictCopyPath(path)) {
          fileActions.push({ type: "upload", path, file: localFile });
          summary.uploaded += 1;
          continue;
        }

        fileActions.push({ type: "deleteLocal", path, file: localFile.file });
        summary.deletedLocal += 1;
        continue;
      }

      if (!localFile && !remoteFile && knownSha !== null) {
        fileActions.push({ type: "metadata", path, sha: null, deleted: true });
        continue;
      }

      if (localFile && remoteFile) {
        fileActions.push({ type: "metadata", path, sha: remoteFile.sha, deleted: false });
      }
    }

    const postFileLocalState = planPostFileLocalState(
      localFolders,
      local,
      fileActions,
      this.shouldIgnorePath,
    );
    const folderActions = planEmptyFolderActions(
      postFileLocalState.folders,
      postFileLocalState.emptyFolders,
      getRemoteEmptyFolders(remote.files),
      this.metadata,
      summary,
      this.shouldIgnorePath,
    );

    return {
      remote,
      summary,
      fileActions,
      folderActions,
    };
  }

  private async executeSyncPlan(plan: SyncPlan, options: SyncExecutionOptions): Promise<SyncSummary> {
    const metadataSnapshot = cloneMetadata(this.metadata.data);
    const now = Date.now();
    const progress = createProgressReporter(plan.summary, options.onProgress);
    try {
      const preparedDownloads = await this.prepareDownloads(plan.fileActions);
      const treeUpdates = await this.prepareRemoteUpdates(plan.fileActions, plan.folderActions, progress);

      if (treeUpdates.size > 0) {
        await this.commitTreeUpdates(plan.remote, treeUpdates);
      }

      await this.applyFileActions(plan.fileActions, preparedDownloads, now, progress);
      await this.applyFolderActions(plan.folderActions, now, progress);
      await this.metadata.save();
      return plan.summary;
    } catch (error) {
      this.metadata.restore(metadataSnapshot);
      this.debugLog?.("sync.metadata-restored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async prepareDownloads(actions: FilePlanAction[]): Promise<Map<string, ArrayBuffer>> {
    const prepared = new Map<string, ArrayBuffer>();

    for (const action of actions) {
      if (action.type === "download") {
        prepared.set(action.path, await this.downloadBlobBytes(action.sha));
      }
    }

    return prepared;
  }

  private async prepareRemoteUpdates(
    fileActions: FilePlanAction[],
    folderActions: FolderPlanAction[],
    progress: ProgressReporter,
  ): Promise<Map<string, string | null>> {
    const treeUpdates = new Map<string, string | null>();
    let markerSha: string | null = null;

    for (const action of fileActions) {
      if (action.type === "upload") {
        action.blobSha = await this.uploadBlob(action.file);
        treeUpdates.set(action.path, action.blobSha);
        progress("upload", action.path);
      }

      if (action.type === "deleteRemote") {
        treeUpdates.set(action.path, null);
        progress("deleteRemote", action.path);
      }
    }

    for (const action of folderActions) {
      if (action.type === "uploadMarker") {
        markerSha ??= await this.uploadEmptyFolderMarker();
        action.markerSha = markerSha;
        treeUpdates.set(action.markerPath, markerSha);
        progress("uploadFolder", action.folderPath);
      }

      if (action.type === "deleteRemoteMarker") {
        treeUpdates.set(action.markerPath, null);
        progress("deleteRemoteFolder", action.folderPath);
      }
    }

    return treeUpdates;
  }

  private async applyFileActions(
    actions: FilePlanAction[],
    preparedDownloads: Map<string, ArrayBuffer>,
    now: number,
    progress: ProgressReporter,
  ): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case "upload":
          if (!action.blobSha) {
            throw new Error(`Missing prepared blob SHA for ${action.path}.`);
          }
          this.metadata.update(
            action.path,
            { sha: action.blobSha, deleted: false, dirty: false },
            now,
          );
          break;
        case "download": {
          const bytes = preparedDownloads.get(action.path);
          if (!bytes) {
            throw new Error(`Missing prepared download for ${action.path}.`);
          }
          await this.writeBlob(action.path, bytes);
          this.metadata.update(action.path, { sha: action.sha, deleted: false, dirty: false }, now);
          progress("download", action.path);
          break;
        }
        case "deleteRemote":
          this.metadata.update(action.path, { sha: null, deleted: true, dirty: false }, now);
          break;
        case "deleteLocal":
          await this.deleteLocalFile(action.file);
          this.metadata.update(action.path, { sha: null, deleted: true, dirty: false }, now);
          progress("deleteLocal", action.path);
          break;
        case "metadata":
          this.metadata.update(
            action.path,
            { sha: action.sha, deleted: action.deleted, dirty: false },
            now,
          );
          break;
      }
    }
  }

  private async applyFolderActions(actions: FolderPlanAction[], now: number, progress: ProgressReporter): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case "uploadMarker":
          if (!action.markerSha) {
            throw new Error(`Missing prepared marker SHA for ${action.folderPath}.`);
          }
          this.metadata.updateFolder(
            action.folderPath,
            { markerSha: action.markerSha, deleted: false },
            now,
          );
          break;
        case "downloadFolder":
          await this.ensureFolder(action.folderPath);
          this.metadata.updateFolder(
            action.folderPath,
            { markerSha: action.markerSha, deleted: false },
            now,
          );
          progress("downloadFolder", action.folderPath);
          break;
        case "deleteRemoteMarker":
          this.metadata.updateFolder(
            action.folderPath,
            { markerSha: null, deleted: true },
            now,
          );
          break;
        case "deleteLocalFolder":
          await this.deleteLocalFolderIfEmpty(action.folderPath);
          this.metadata.updateFolder(
            action.folderPath,
            { markerSha: null, deleted: true },
            now,
          );
          progress("deleteLocalFolder", action.folderPath);
          break;
        case "updateFolder":
          this.metadata.updateFolder(
            action.folderPath,
            { markerSha: action.markerSha, deleted: action.deleted },
            now,
          );
          break;
        case "removeFolder":
          this.metadata.removeFolder(action.folderPath);
          break;
      }
    }
  }

  async resolveConflicts(paths: string[], resolution: ConflictResolution): Promise<SyncSummary> {
    this.validateSettings();

    const metadataSnapshot = cloneMetadata(this.metadata.data);
    const now = Date.now();
    try {
      const remote = await this.getRemoteState();
      const local = await this.getLocalFiles();
      const summary: SyncSummary = {
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
      this.debugLog?.("conflict-resolution.scan", {
        resolution,
        paths,
        localFiles: local.size,
        remoteFiles: remote.files.size,
      });

      if (resolution === "local") {
        const treeUpdates = new Map<string, string | null>();

        for (const path of paths) {
          const localFile = local.get(path);

          if (!localFile) {
            treeUpdates.set(path, null);
            this.metadata.update(path, { sha: null, deleted: true, dirty: false }, now);
            summary.deletedRemote += 1;
            continue;
          }

          const blobSha = await this.uploadBlob(localFile);
          treeUpdates.set(path, blobSha);
          this.metadata.update(path, { sha: blobSha, deleted: false, dirty: false }, now);
          summary.uploaded += 1;
        }

        if (treeUpdates.size > 0) {
          await this.commitTreeUpdates(remote, treeUpdates);
        }
      } else {
        const treeUpdates = new Map<string, string | null>();

        for (const path of paths) {
          const localFile = local.get(path);
          const remoteFile = remote.files.get(path);

          if (remoteFile) {
            if (resolution === "both" && localFile) {
              const conflictCopy = await this.createLocalConflictCopy(localFile);
              const blobSha = await this.uploadBytes(conflictCopy.bytes);
              treeUpdates.set(conflictCopy.path, blobSha);
              this.metadata.update(
                conflictCopy.path,
                { sha: blobSha, deleted: false, dirty: false },
                now,
              );
              summary.uploaded += 1;
            }

            await this.downloadBlob(path, remoteFile.sha);
            this.metadata.update(path, { sha: remoteFile.sha, deleted: false, dirty: false }, now);
            summary.downloaded += 1;
            continue;
          }

          if (localFile) {
            if (resolution === "both") {
              const conflictCopy = await this.createLocalConflictCopy(localFile);
              const blobSha = await this.uploadBytes(conflictCopy.bytes);
              treeUpdates.set(conflictCopy.path, blobSha);
              this.metadata.update(
                conflictCopy.path,
                { sha: blobSha, deleted: false, dirty: false },
                now,
              );
              summary.uploaded += 1;
            }

            await this.deleteLocalFile(localFile.file);
            this.metadata.update(path, { sha: null, deleted: true, dirty: false }, now);
            summary.deletedLocal += 1;
          }
        }

        if (treeUpdates.size > 0) {
          await this.commitTreeUpdates(remote, treeUpdates);
        }
      }

      await this.metadata.save();
      return summary;
    } catch (error) {
      this.metadata.restore(metadataSnapshot);
      this.debugLog?.("conflict-resolution.metadata-restored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private validateSettings(): void {
    const missing = [
      ["owner", this.settings.owner],
      ["repository", this.settings.repo],
      ["branch", this.settings.branch],
    ].filter(([, value]) => !value);

    if (missing.length > 0) {
      throw new Error(`Missing GitHub ${missing.map(([label]) => label).join(", ")} setting.`);
    }
  }

  private async getRemoteState(): Promise<RemoteState> {
    return this.github.getRemoteFiles(
      this.settings.owner,
      this.settings.repo,
      this.settings.branch,
    );
  }

  private async getLocalFiles(): Promise<Map<string, LocalFileSnapshot>> {
    const snapshots = new Map<string, LocalFileSnapshot>();

    for (const file of this.vault.getFiles()) {
      if (this.shouldIgnorePath(file.path)) {
        continue;
      }

      const bytes = await this.vault.readBinary(file);
      snapshots.set(file.path, {
        file,
        path: file.path,
        sha: await gitBlobSha(bytes),
        bytes,
      });
    }

    return snapshots;
  }

  private async getLocalFile(path: string): Promise<LocalFileSnapshot | null> {
    const file = this.vault.getAbstractFileByPath(path);

    if (!(file instanceof TFile) || this.shouldIgnorePath(file.path)) {
      return null;
    }

    const bytes = await this.vault.readBinary(file);
    return {
      file,
      path: file.path,
      sha: await gitBlobSha(bytes),
      bytes,
    };
  }

  private async hasLocalFolderChange(folderPath: string): Promise<boolean> {
    if (!folderPath || this.shouldIgnorePath(`${folderPath}/`)) {
      return false;
    }

    const existing = this.vault.getAbstractFileByPath(folderPath);
    const localExists = existing instanceof TFolder;
    const localEmpty = localExists && this.isLocalFolderEmpty(existing);
    const record = this.metadata.getFolder(folderPath);

    if (localEmpty && !record?.markerSha) {
      return true;
    }

    return Boolean(record?.markerSha && (!localExists || !localEmpty));
  }

  private getLocalEmptyFolders(): Set<string> {
    const folders = new Set<string>();

    for (const file of this.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder)) {
        continue;
      }

      if (!file.path || file.path === "/" || this.shouldIgnorePath(`${file.path}/`)) {
        continue;
      }

      if (this.isLocalFolderEmpty(file)) {
        folders.add(file.path);
      }
    }

    return folders;
  }

  private getLocalFolders(): Set<string> {
    const folders = new Set<string>();

    for (const file of this.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder)) {
        continue;
      }

      if (!file.path || file.path === "/" || this.shouldIgnorePath(`${file.path}/`)) {
        continue;
      }

      folders.add(file.path);
    }

    return folders;
  }

  private async uploadBlob(file: LocalFileSnapshot): Promise<string> {
    return this.uploadBytes(file.bytes);
  }

  private async uploadBytes(bytes: ArrayBuffer): Promise<string> {
    const blob = await this.github.createBlob(
      this.settings.owner,
      this.settings.repo,
      bytesToBase64(bytes),
    );

    return blob.sha;
  }

  private async downloadBlob(path: string, sha: string): Promise<void> {
    await this.writeBlob(path, await this.downloadBlobBytes(sha));
  }

  private async downloadBlobBytes(sha: string): Promise<ArrayBuffer> {
    const blob = await this.github.getBlob(this.settings.owner, this.settings.repo, sha);
    return blob.encoding === "base64"
      ? base64ToBytes(blob.content)
      : new TextEncoder().encode(blob.content).buffer;
  }

  private async writeBlob(path: string, bytes: ArrayBuffer): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      try {
        await this.vault.modifyBinary(existing, bytes);
      } catch (error) {
        if (!isFileAlreadyExistsError(error)) {
          throw error;
        }

        await this.fileManager.trashFile(existing);
        await this.ensureParentFolder(path);
        await this.vault.createBinary(path, bytes);
      }
      return;
    }

    if (existing instanceof TFolder) {
      throw new Error(`Cannot write file ${path}; a folder already exists there.`);
    }

    await this.ensureParentFolder(path);
    await this.vault.createBinary(path, bytes);
  }

  private async deleteLocalFile(file: TFile): Promise<void> {
    await this.fileManager.trashFile(file);
  }

  private async createLocalConflictCopy(
    file: LocalFileSnapshot,
  ): Promise<{ path: string; bytes: ArrayBuffer }> {
    const conflictPath = await this.nextConflictPath(file.path);
    await this.ensureParentFolder(conflictPath);
    await this.vault.createBinary(conflictPath, file.bytes);
    return {
      path: conflictPath,
      bytes: file.bytes,
    };
  }

  private async nextConflictPath(path: string): Promise<string> {
    const parsed = parsePath(path);
    const timestamp = formatConflictTimestamp(new Date());
    let candidate = `${parsed.prefix}${parsed.basename}.local-conflict-${timestamp}${parsed.extension}`;
    let index = 2;

    while (this.vault.getAbstractFileByPath(candidate)) {
      candidate = `${parsed.prefix}${parsed.basename}.local-conflict-${timestamp}-${index}${parsed.extension}`;
      index += 1;
    }

    return candidate;
  }

  private async uploadEmptyFolderMarker(): Promise<string> {
    const markerBytes = new TextEncoder().encode(EMPTY_FOLDER_MARKER_CONTENT);
    const blob = await this.github.createBlob(
      this.settings.owner,
      this.settings.repo,
      bytesToBase64(markerBytes.buffer),
    );

    return blob.sha;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault.getAbstractFileByPath(current);

      if (existing instanceof TFolder) {
        continue;
      }

      if (existing) {
        throw new Error(`Cannot create folder ${current}; a file already exists there.`);
      }

      await this.vault.createFolder(current);
    }
  }

  private async deleteLocalFolderIfEmpty(path: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);

    if (!(existing instanceof TFolder)) {
      return;
    }

    if (!this.isLocalFolderEmpty(existing)) {
      return;
    }

    await this.fileManager.trashFile(existing);
  }

  private isLocalFolderEmpty(folder: TFolder): boolean {
    return folder.children.every((child) => {
      const childPath = child instanceof TFolder ? `${child.path}/` : child.path;
      return this.shouldIgnorePath(childPath);
    });
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault.getAbstractFileByPath(current);

      if (existing instanceof TFolder) {
        continue;
      }

      if (existing) {
        throw new Error(`Cannot create folder ${current}; a file already exists there.`);
      }

      await this.vault.createFolder(current);
    }
  }

  private async commitTreeUpdates(
    remote: RemoteState,
    updates: Map<string, string | null>,
  ): Promise<void> {
    let latestRemote = remote;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.debugLog?.("sync.commit.attempt", {
          attempt: attempt + 1,
          baseCommit: latestRemote.commitSha,
          baseTree: latestRemote.treeSha,
          updates: updates.size,
        });
        await this.commitTreeUpdatesOnce(latestRemote, updates);
        this.debugLog?.("sync.commit.success", {
          attempt: attempt + 1,
        });
        return;
      } catch (error) {
        if (!isNonFastForwardError(error) || attempt === 2) {
          this.debugLog?.("sync.commit.failed", {
            attempt: attempt + 1,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        this.debugLog?.("sync.commit.retry-non-fast-forward", {
          attempt: attempt + 1,
          message: error instanceof Error ? error.message : String(error),
        });
        await delay(350);
        latestRemote = await this.getRemoteState();
        assertUpdatedPathsStillSafeToApply(remote, latestRemote, updates);
      }
    }
  }

  private async commitTreeUpdatesOnce(
    remote: RemoteState,
    updates: Map<string, string | null>,
  ): Promise<void> {
    const tree = await this.github.createTree(
      this.settings.owner,
      this.settings.repo,
      remote.treeSha,
      Array.from(updates.entries()).map(([path, sha]) => ({
        path,
        mode: "100644",
        type: "blob",
        sha,
      })),
    );

    const commit = await this.github.createCommit(
      this.settings.owner,
      this.settings.repo,
      `Octosync ${new Date().toISOString()}`,
      tree.sha,
      remote.commitSha,
    );

    await this.github.updateBranchRef(
      this.settings.owner,
      this.settings.repo,
      this.settings.branch,
      commit.sha,
    );
  }

  private shouldIgnorePath = (path: string): boolean => shouldIgnorePath(path, this.vault.configDir, getConfigAllowedPaths(this.settings, this.vault.configDir), this.settings.syncExcludePaths);
}

function createEmptySummary(): SyncSummary {
  return {
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
}

type ProgressReporter = (operation: SyncProgress["operation"], path: string) => void;

function createProgressReporter(summary: SyncSummary, onProgress?: (progress: SyncProgress) => void): ProgressReporter {
  const total =
    summary.uploaded +
    summary.downloaded +
    summary.deletedRemote +
    summary.deletedLocal +
    summary.foldersUploaded +
    summary.foldersDownloaded +
    summary.foldersDeletedRemote +
    summary.foldersDeletedLocal;
  let completed = 0;

  return (operation, path) => {
    completed += 1;
    onProgress?.({
      completed,
      total,
      operation,
      path,
    });
  };
}

function planPostFileLocalState(
  localFolders: Set<string>,
  localFiles: Map<string, LocalFileSnapshot>,
  actions: FilePlanAction[],
  shouldIgnore: IgnorePath,
): { folders: Set<string>; emptyFolders: Set<string> } {
  const postFiles = new Set(localFiles.keys());
  const postFolders = new Set(localFolders);

  for (const action of actions) {
    if (action.type === "download") {
      postFiles.add(action.path);
      addParentFolders(action.path, postFolders, shouldIgnore);
    }

    if (action.type === "deleteLocal") {
      postFiles.delete(action.path);
    }
  }

  return {
    folders: postFolders,
    emptyFolders: getEmptyFolders(postFolders, postFiles, shouldIgnore),
  };
}

function planEmptyFolderActions(
  localFolders: Set<string>,
  localEmptyFolders: Set<string>,
  remoteEmptyFolders: Map<string, RemoteFile>,
  metadata: MetadataStore,
  summary: SyncSummary,
  shouldIgnore: IgnorePath,
): FolderPlanAction[] {
  const actions: FolderPlanAction[] = [];
  const allFolders = new Set<string>([
    ...localEmptyFolders,
    ...remoteEmptyFolders.keys(),
    ...Object.keys(metadata.data.folders),
  ]);

  for (const folderPath of allFolders) {
    if (shouldIgnore(`${folderPath}/`)) {
      continue;
    }

    const localEmpty = localEmptyFolders.has(folderPath);
    const localExists = localFolders.has(folderPath);
    const remoteMarker = remoteEmptyFolders.get(folderPath);
    const record = metadata.getFolder(folderPath);
    const knownMarkerSha = record?.markerSha ?? null;
    const markerPath = markerPathForFolder(folderPath);

    if (localEmpty && !remoteMarker && knownMarkerSha === null) {
      actions.push({ type: "uploadMarker", folderPath, markerPath });
      summary.foldersUploaded += 1;
      continue;
    }

    if (!localExists && remoteMarker && knownMarkerSha === null) {
      actions.push({ type: "downloadFolder", folderPath, markerSha: remoteMarker.sha });
      summary.foldersDownloaded += 1;
      continue;
    }

    if (!localExists && remoteMarker && knownMarkerSha === remoteMarker.sha) {
      actions.push({ type: "deleteRemoteMarker", folderPath, markerPath });
      summary.foldersDeletedRemote += 1;
      continue;
    }

    if (localEmpty && !remoteMarker && knownMarkerSha !== null) {
      actions.push({ type: "deleteLocalFolder", folderPath });
      summary.foldersDeletedLocal += 1;
      continue;
    }

    if (localEmpty && remoteMarker) {
      actions.push({
        type: "updateFolder",
        folderPath,
        markerSha: remoteMarker.sha,
        deleted: false,
      });
      continue;
    }

    if (localExists && !localEmpty && remoteMarker) {
      actions.push({ type: "deleteRemoteMarker", folderPath, markerPath });
      summary.foldersDeletedRemote += 1;
      continue;
    }

    if (localExists && !localEmpty && !remoteMarker) {
      actions.push({ type: "removeFolder", folderPath });
      continue;
    }

    actions.push({ type: "removeFolder", folderPath });
  }

  return actions;
}

function addParentFolders(path: string, folders: Set<string>, shouldIgnore: IgnorePath): void {
  const parts = path.split("/").slice(0, -1);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;

    if (!shouldIgnore(`${current}/`)) {
      folders.add(current);
    }
  }
}

function getEmptyFolders(
  folders: Set<string>,
  files: Set<string>,
  shouldIgnore: IgnorePath,
): Set<string> {
  const foldersWithChildren = new Set<string>();

  for (const folder of folders) {
    const parent = parentFolderPath(folder);
    if (parent && folders.has(parent)) {
      foldersWithChildren.add(parent);
    }
  }

  for (const file of files) {
    const parent = parentFolderPath(file);
    if (parent && folders.has(parent)) {
      foldersWithChildren.add(parent);
    }
  }

  return new Set(
    Array.from(folders).filter(
      (folder) => !foldersWithChildren.has(folder) && !shouldIgnore(`${folder}/`),
    ),
  );
}

function parentFolderPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex === -1 ? "" : path.slice(0, slashIndex);
}

export function formatSummary(summary: SyncSummary): string {
  if (!hasUserVisibleSyncChanges(summary)) {
    return "No sync required. Everything is up to date.";
  }

  const parts = [
    `${summary.uploaded} uploaded`,
    `${summary.downloaded} downloaded`,
    `${summary.deletedLocal} local deletions`,
    `${summary.deletedRemote} remote deletions`,
    `${summary.foldersUploaded} folders uploaded`,
    `${summary.foldersDownloaded} folders downloaded`,
    `${summary.foldersDeletedLocal} local folder deletions`,
    `${summary.foldersDeletedRemote} remote folder deletions`,
  ];

  if (summary.conflicts.length > 0) {
    parts.push(`${summary.conflicts.length} conflicts`);
  }

  return parts.join(", ");
}

export function notifySummary(summary: SyncSummary): void {
  new Notice(`Octosync complete: ${formatSummary(summary)}`);
}

export function hasUserVisibleSyncChanges(summary: SyncSummary): boolean {
  return (
    summary.uploaded > 0 ||
    summary.downloaded > 0 ||
    summary.deletedLocal > 0 ||
    summary.deletedRemote > 0 ||
    summary.foldersUploaded > 0 ||
    summary.foldersDownloaded > 0 ||
    summary.foldersDeletedLocal > 0 ||
    summary.foldersDeletedRemote > 0 ||
    summary.conflicts.length > 0
  );
}

export type ConflictResolution = "local" | "remote" | "both";

export class SyncConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(`Sync stopped with ${conflicts.length} conflict(s).`);
    this.name = "SyncConflictError";
  }
}

export function getConfigAllowedPaths(settings: OctosyncSettings, configDir: string): string[] {
  const paths: string[] = [];

  if (settings.syncCommunityPlugins) {
    paths.push(`${configDir}/community-plugins.json`);
  }

  if (settings.syncThemes) {
    paths.push(`${configDir}/themes`);
  }

  if (settings.syncSnippets) {
    paths.push(`${configDir}/snippets`);
  }

  return paths;
}

export function shouldIgnorePath(path: string, configDir: string, allowedConfigPaths: string[] = [], excludePatterns: string[] = []): boolean {
  const configPrefix = configDir.endsWith("/") ? configDir : `${configDir}/`;

  if (path === configDir || path.startsWith(configPrefix)) {
    if (allowedConfigPaths.some((allowed) => {
      const allowedPrefix = allowed.endsWith("/") ? allowed : `${allowed}/`;
      return path === allowed || path.startsWith(allowedPrefix);
    })) {
      // Even inside an allowed config path, reserved filenames and Octosync's own
      // empty-folder markers must still be excluded. Use filename-based matching so
      // that e.g. .DS_Store inside a theme folder is treated the same as at the root.
      const filename = path.split("/").pop() ?? "";

      if (
        RESERVED_FILES.has(filename) ||
        isEmptyFolderMarkerPath(path) ||
        excludePatterns.some((pattern) => matchesExcludePattern(path, pattern))
      ) {
        return true;
      }

      return false;
    }

    return true;
  }

  return (
    RESERVED_FILES.has(path) ||
    isEmptyFolderMarkerPath(path) ||
    RESERVED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/**
 * Returns true when `path` matches `pattern`.
 * - If `pattern` contains a `/`, it is treated as a path prefix: the path must equal the pattern
 *   or start with `pattern + "/"`.
 * - Otherwise the pattern is treated as a filename and is compared to the last path segment.
 */
export function matchesExcludePattern(path: string, pattern: string): boolean {
  if (pattern.includes("/")) {
    const prefix = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return path === pattern || path.startsWith(prefix);
  }

  const filename = path.split("/").pop() ?? "";
  return filename === pattern;
}

function findFileConflicts(
  paths: Set<string>,
  local: Map<string, LocalFileSnapshot>,
  remote: Map<string, RemoteFile>,
  metadata: MetadataStore,
  shouldIgnore: IgnorePath,
): string[] {
  const conflicts: string[] = [];

  for (const path of paths) {
    if (shouldIgnore(path)) {
      continue;
    }

    if (isFileConflict(local.get(path), remote.get(path), metadata.get(path)?.sha ?? null)) {
      conflicts.push(path);
    }
  }

  return conflicts;
}

function findPathShapeConflicts(
  localFiles: Map<string, LocalFileSnapshot>,
  localFolders: Set<string>,
  remoteFiles: Map<string, RemoteFile>,
  shouldIgnore: IgnorePath,
): string[] {
  const conflicts = new Set<string>();
  const remoteFolders = getRemoteFolders(remoteFiles, shouldIgnore);

  for (const remoteFolderPath of remoteFolders) {
    for (const ancestorPath of ancestorPathsInclusive(remoteFolderPath)) {
      if (localFiles.has(ancestorPath) && !shouldIgnore(ancestorPath)) {
        conflicts.add(ancestorPath);
      }
    }
  }

  for (const localFolderPath of localFolders) {
    for (const ancestorPath of ancestorPathsInclusive(localFolderPath)) {
      if (remoteFiles.has(ancestorPath) && !shouldIgnore(ancestorPath)) {
        conflicts.add(ancestorPath);
      }
    }
  }

  return [...conflicts].sort();
}

function getRemoteFolders(remoteFiles: Map<string, RemoteFile>, shouldIgnore: IgnorePath): Set<string> {
  const folders = new Set<string>();

  for (const remotePath of remoteFiles.keys()) {
    addParentFolders(remotePath, folders, shouldIgnore);
  }

  for (const folderPath of getRemoteEmptyFolders(remoteFiles).keys()) {
    if (!shouldIgnore(`${folderPath}/`)) {
      folders.add(folderPath);
    }
  }

  return folders;
}

function ancestorPathsInclusive(path: string): string[] {
  const ancestors = [path];
  let current = path;

  while (current.includes("/")) {
    current = parentFolderPath(current);
    if (current) {
      ancestors.push(current);
    }
  }

  return ancestors;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && /file already exists/i.test(error.message);
}

function isFileConflict(
  localFile: LocalFileSnapshot | undefined,
  remoteFile: RemoteFile | undefined,
  knownSha: string | null,
): boolean {
  if (localFile && remoteFile && localFile.sha === remoteFile.sha) {
    return false;
  }

  if (knownSha === null) {
    return Boolean(localFile && remoteFile);
  }

  if (localFile && remoteFile) {
    return localFile.sha !== knownSha && remoteFile.sha !== knownSha;
  }

  if (localFile && !remoteFile) {
    return localFile.sha !== knownSha;
  }

  if (!localFile && remoteFile) {
    return remoteFile.sha !== knownSha;
  }

  return false;
}

function assertUpdatedPathsStillSafeToApply(
  originalRemote: RemoteState,
  latestRemote: RemoteState,
  updates: Map<string, string | null>,
): void {
  for (const [path, wantedSha] of updates) {
    const originalSha = originalRemote.files.get(path)?.sha ?? null;
    const latestSha = latestRemote.files.get(path)?.sha ?? null;

    if (latestSha !== originalSha && latestSha !== wantedSha) {
      throw new Error(
        `Remote changed ${path} during sync. Sync stopped to avoid overwriting newer remote changes.`,
      );
    }
  }
}

function getRemoteEmptyFolders(remoteFiles: Map<string, RemoteFile>): Map<string, RemoteFile> {
  const folders = new Map<string, RemoteFile>();

  for (const [path, file] of remoteFiles) {
    const folder = folderPathFromMarker(path);

    if (folder) {
      folders.set(folder, file);
    }
  }

  return folders;
}

function markerPathForFolder(folderPath: string): string {
  return `${folderPath}/${EMPTY_FOLDER_MARKER_NAME}`;
}

function folderPathFromMarker(path: string): string | null {
  if (path === EMPTY_FOLDER_MARKER_NAME) {
    return null;
  }

  const suffix = `/${EMPTY_FOLDER_MARKER_NAME}`;
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : null;
}

function isEmptyFolderMarkerPath(path: string): boolean {
  return path === EMPTY_FOLDER_MARKER_NAME || path.endsWith(`/${EMPTY_FOLDER_MARKER_NAME}`);
}

function isLocalConflictCopyPath(path: string): boolean {
  return /\.local-conflict-\d{8}-\d{6}(?:-\d+)?(?:\.[^/]+)?$/.test(path);
}

function parsePath(path: string): { prefix: string; basename: string; extension: string } {
  const slashIndex = path.lastIndexOf("/");
  const prefix = slashIndex === -1 ? "" : `${path.slice(0, slashIndex)}/`;
  const filename = slashIndex === -1 ? path : path.slice(slashIndex + 1);
  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex <= 0) {
    return {
      prefix,
      basename: filename,
      extension: "",
    };
  }

  return {
    prefix,
    basename: filename.slice(0, dotIndex),
    extension: filename.slice(dotIndex),
  };
}

function formatConflictTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function cloneMetadata(metadata: SyncMetadata): SyncMetadata {
  return {
    version: metadata.version,
    files: Object.fromEntries(
      Object.entries(metadata.files).map(([path, record]) => [path, { ...record }]),
    ),
    folders: Object.fromEntries(
      Object.entries(metadata.folders).map(([path, record]) => [path, { ...record }]),
    ),
  };
}

function isNonFastForwardError(error: unknown): boolean {
  return (
    error instanceof GitHubRequestError &&
    error.status === 422 &&
    /fast[- ]?forward/i.test(error.message)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

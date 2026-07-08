import { addIcon, Modal, Notice, Plugin } from "obsidian";
import { createAuthProvider } from "./auth";
import { ConflictResolutionModal } from "./conflict-modal";
import { DebugLog, type DebugLogEntry } from "./debug-log";
import { GitHubClient } from "./github";
import { OCTOSYNC_ICON } from "./icons";
import { MetadataStore } from "./metadata";
import { OctosyncSettingTab } from "./settings-tab";
import {
  type ConflictResolution,
  formatSummary,
  notifySummary,
  SyncConflictError,
  SyncManager,
  type SyncProgress,
} from "./sync";
import { DEFAULT_SETTINGS, type OctosyncSettings, type SyncSummary } from "./types";

interface OctosyncPluginData {
  settings?: Partial<OctosyncSettings>;
  metadata?: unknown;
  debugLog?: DebugLogEntry[];
}

const LOCAL_CHANGE_DEBOUNCE_MS = 500;
const LOCAL_FULL_SCAN_INTERVAL_MS = 5 * 60 * 1000;

export default class OctosyncPlugin extends Plugin {
  settings: OctosyncSettings = { ...DEFAULT_SETTINGS };
  private metadata!: MetadataStore;
  private syncInFlight: Promise<void> | null = null;
  private intervalId: number | null = null;
  private localChangeScanTimeout: number | null = null;
  private localFullScanIntervalId: number | null = null;
  private remoteChangeCheckIntervalId: number | null = null;
  private dirtyLocalPaths = new Set<string>();
  private localChangeScanId = 0;
  private hasLocalChangesToSync = false;
  private hasRemoteChangesToSync = false;
  private ribbonIconEl: HTMLElement | null = null;
  private debugLog!: DebugLog;
  private pendingConflictPaths: string[] | null = null;
  private conflictModal: ConflictResolutionModal | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.debugLog = new DebugLog(this.settings, async (entries) => {
      await this.savePluginData({ debugLog: entries });
    });
    this.debugLog.load((await this.loadPluginData()).debugLog);

    this.metadata = new MetadataStore(
      async () => (await this.loadPluginData()).metadata,
      async (metadata) => {
        await this.savePluginData({ metadata });
      },
    );
    await this.metadata.load();

    addIcon("octosync-logo", OCTOSYNC_ICON);

    this.ribbonIconEl = this.addRibbonIcon("octosync-logo", "Sync with Octosync", () => {
      void this.syncNow();
    });
    this.ribbonIconEl.parentElement?.appendChild(this.ribbonIconEl);
    this.updateSyncUiState();
    this.registerLocalChangeTracking();
    this.configureChangeIndicators();

    this.addCommand({
      id: "sync-now",
      name: "Sync with GitHub",
      callback: () => {
        void this.syncNow();
      },
    });

    this.addSettingTab(new OctosyncSettingTab(this.app, this));
    this.configureIntervalSync();

    if (this.settings.syncMode === "automatic" && this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        void this.requestSync({ source: "automatic" });
      });
    }
  }

  onunload(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.localChangeScanTimeout !== null) {
      window.clearTimeout(this.localChangeScanTimeout);
      this.localChangeScanTimeout = null;
    }

    this.clearLocalFullScanInterval();
    this.clearRemoteChangeCheckInterval();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadPluginData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(data.settings ?? {}),
    };
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData({ settings: this.settings });
  }

  getDebugLogText(): string {
    return this.debugLog.format();
  }

  getDebugLogCount(): number {
    return this.debugLog.getEntries().length;
  }

  async clearDebugLog(): Promise<void> {
    await this.debugLog.clear();
  }

  configureIntervalSync(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.settings.syncMode !== "automatic" || this.settings.syncIntervalMinutes <= 0) {
      return;
    }

    this.intervalId = window.setInterval(() => {
      void this.requestSync({ source: "automatic" });
    }, this.settings.syncIntervalMinutes * 60 * 1000);

    this.registerInterval(this.intervalId);
  }

  configureChangeIndicators(): void {
    this.clearLocalFullScanInterval();
    this.clearRemoteChangeCheckInterval();

    if (!this.settings.localChangeIndicatorEnabled) {
      this.dirtyLocalPaths.clear();
      this.hasLocalChangesToSync = false;
      this.updateSyncUiState();
    } else {
      this.scheduleLocalChangeScan({ full: true, delay: 0 });

      if (this.settings.localChangePeriodicFullScan) {
        this.localFullScanIntervalId = window.setInterval(() => {
          this.scheduleLocalChangeScan({ full: true, delay: 0 });
        }, LOCAL_FULL_SCAN_INTERVAL_MS);
        this.registerInterval(this.localFullScanIntervalId);
      }
    }

    if (this.shouldPollRemoteChanges()) {
      void this.refreshRemoteChangeIndicator();
      this.remoteChangeCheckIntervalId = window.setInterval(() => {
        void this.refreshRemoteChangeIndicator();
      }, this.settings.remoteChangeCheckIntervalMinutes * 60 * 1000);
      this.registerInterval(this.remoteChangeCheckIntervalId);
    } else {
      this.hasRemoteChangesToSync = false;
      this.updateSyncUiState();
    }
  }

  async syncNow(): Promise<void> {
    return this.requestSync({ source: "manual" });
  }

  async simulateSync(): Promise<void> {
    return this.runWithSyncLock(() => this.runSimulation(), { source: "manual" });
  }

  async resolveConflicts(paths: string[], resolution: ConflictResolution): Promise<void> {
    return this.runWithSyncLock(() => this.runConflictResolution(paths, resolution), {
      allowWhileConflictsPending: true,
      source: "manual",
    });
  }

  isSyncing(): boolean {
    return this.syncInFlight !== null;
  }

  private createSyncManager(): SyncManager {
    return new SyncManager(
      this.app.vault,
      this.app.fileManager,
      new GitHubClient(createAuthProvider(this.settings), (message, data) => {
        this.debugLog.write(message, data);
      }),
      this.metadata,
      this.settings,
      (message, data) => {
        this.debugLog.write(message, data);
      },
    );
  }

  private registerLocalChangeTracking(): void {
    this.registerEvent(this.app.vault.on("create", (file) => this.queueLocalChangePath(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.queueLocalChangePath(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.queueLocalChangePath(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.queueLocalChangePath(oldPath);
        this.queueLocalChangePath(file.path);
      }),
    );
  }

  private queueLocalChangePath(path: string): void {
    if (!this.settings.localChangeIndicatorEnabled) {
      return;
    }

    this.dirtyLocalPaths.add(path);
    this.addParentDirtyPaths(path);
    this.scheduleLocalChangeScan({ full: false });
  }

  private addParentDirtyPaths(path: string): void {
    const parts = path.split("/").slice(0, -1);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.dirtyLocalPaths.add(current);
    }
  }

  private scheduleLocalChangeScan(options: { full: boolean; delay?: number }): void {
    if (!this.settings.localChangeIndicatorEnabled) {
      return;
    }

    if (this.localChangeScanTimeout !== null) {
      window.clearTimeout(this.localChangeScanTimeout);
    }

    const delay = options.delay ?? LOCAL_CHANGE_DEBOUNCE_MS;
    this.localChangeScanTimeout = window.setTimeout(() => {
      this.localChangeScanTimeout = null;
      void this.refreshLocalChangeIndicator(options.full);
    }, delay);
  }

  private async refreshLocalChangeIndicator(full: boolean): Promise<void> {
    if (!this.settings.localChangeIndicatorEnabled) {
      this.hasLocalChangesToSync = false;
      this.updateSyncUiState();
      return;
    }

    const scanId = ++this.localChangeScanId;
    const dirtyPaths = new Set(this.dirtyLocalPaths);

    try {
      const hasChanges = full
        ? await this.createSyncManager().hasLocalChanges()
        : await this.createSyncManager().hasLocalChangesForPaths(dirtyPaths);

      if (scanId !== this.localChangeScanId) {
        return;
      }

      this.hasLocalChangesToSync = hasChanges;
      if (full || !hasChanges) {
        this.dirtyLocalPaths.clear();
      }
      this.updateSyncUiState();
    } catch (error) {
      this.debugLog.write("local-change-scan.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async refreshRemoteChangeIndicator(): Promise<void> {
    if (!this.shouldPollRemoteChanges() || this.syncInFlight) {
      return;
    }

    try {
      this.hasRemoteChangesToSync = await this.createSyncManager().hasRemoteChanges();
      this.updateSyncUiState();
    } catch (error) {
      this.debugLog.write("remote-change-check.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private shouldPollRemoteChanges(): boolean {
    return (
      this.settings.syncMode === "manual" &&
      this.settings.remoteChangeIndicatorEnabled &&
      this.settings.remoteChangeCheckIntervalMinutes > 0
    );
  }

  private clearLocalFullScanInterval(): void {
    if (this.localFullScanIntervalId !== null) {
      window.clearInterval(this.localFullScanIntervalId);
      this.localFullScanIntervalId = null;
    }
  }

  private clearRemoteChangeCheckInterval(): void {
    if (this.remoteChangeCheckIntervalId !== null) {
      window.clearInterval(this.remoteChangeCheckIntervalId);
      this.remoteChangeCheckIntervalId = null;
    }
  }

  private async requestSync(options: { source: "manual" | "automatic" }): Promise<void> {
    if (this.pendingConflictPaths) {
      this.debugLog.write("sync.skipped.pending-conflicts", {
        source: options.source,
        count: this.pendingConflictPaths.length,
        conflicts: this.pendingConflictPaths,
      });

      if (options.source === "manual") {
        new Notice("Octosync has unresolved conflicts.");
        this.openConflictModal(this.pendingConflictPaths);
      }

      return;
    }

    return this.runWithSyncLock(
      () =>
        this.runSync({
          confirm: this.settings.syncMode === "manual" && this.settings.confirmBeforeManualSync,
        }),
      options,
    );
  }

  private async runWithSyncLock(
    operation: () => Promise<void>,
    options: {
      allowWhileConflictsPending?: boolean;
      source: "manual" | "automatic";
    },
  ): Promise<void> {
    if (this.pendingConflictPaths && !options.allowWhileConflictsPending) {
      this.debugLog.write("sync.lock.skipped.pending-conflicts", {
        source: options.source,
        count: this.pendingConflictPaths.length,
        conflicts: this.pendingConflictPaths,
      });

      if (options.source === "manual") {
        new Notice("Octosync has unresolved conflicts.");
        this.openConflictModal(this.pendingConflictPaths);
      }

      return;
    }

    if (this.syncInFlight) {
      if (options.source === "manual") {
        new Notice("Octosync is already syncing.");
      }
      return this.syncInFlight;
    }

    this.syncInFlight = Promise.resolve().then(operation);
    this.debugLog.write("sync.lock.acquired");
    this.updateSyncUiState();

    try {
      await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
      this.debugLog.write("sync.lock.released");
      this.updateSyncUiState();
    }
  }

  private updateSyncUiState(): void {
    if (!this.ribbonIconEl) {
      return;
    }

    const syncing = this.isSyncing();
    this.ribbonIconEl.toggleClass("is-syncing", syncing);
    this.ribbonIconEl.toggleClass(
      "has-local-changes",
      this.settings.localChangeIndicatorEnabled && this.hasLocalChangesToSync && !syncing,
    );
    this.ribbonIconEl.toggleClass("has-remote-changes", this.hasRemoteChangesToSync && !syncing);
    this.ribbonIconEl.setAttribute("aria-disabled", syncing ? "true" : "false");
    const label = getRibbonLabel(
      syncing,
      this.settings.localChangeIndicatorEnabled && this.hasLocalChangesToSync,
      this.hasRemoteChangesToSync,
    );
    this.ribbonIconEl.setAttribute("aria-label", label);
    this.ribbonIconEl.setAttribute("title", label);
  }

  private async runSync(options: { confirm: boolean }): Promise<void> {
    let progressNotice: Notice | null = null;

    try {
      this.debugLog.write("sync.start", {
        owner: this.settings.owner,
        repo: this.settings.repo,
        branch: this.settings.branch,
        confirm: options.confirm,
      });

      const manager = this.createSyncManager();
      progressNotice = new Notice("Octosync: preparing sync plan...", 0);
      const summary = options.confirm
        ? await manager.syncWithConfirmation(
            async (plannedSummary) => {
              progressNotice?.hide();
              progressNotice = null;
              return new SyncConfirmationModal(this, plannedSummary).confirm();
            },
            {
              onProgress: (progress) => {
                progressNotice ??= new Notice(formatSyncProgress(progress), 0);
                progressNotice.setMessage(formatSyncProgress(progress));
              },
            },
          )
        : await manager.sync({
            onProgress: (progress) => {
              progressNotice?.setMessage(formatSyncProgress(progress));
            },
          });

      if (!summary) {
        this.debugLog.write("sync.cancelled");
        progressNotice?.hide();
        new Notice("Octosync sync cancelled.");
        return;
      }

      this.settings.lastSyncStartedAt = Date.now();
      this.settings.lastSyncCompletedAt = Date.now();
      this.settings.lastSyncSummary = formatSummary(summary);
      await this.saveSettings();
      this.debugLog.write("sync.complete", summary);
      progressNotice?.hide();
      notifySummary(summary);
      this.dirtyLocalPaths.clear();
      await this.refreshPostOperationIndicators();
    } catch (error) {
      if (error instanceof SyncConflictError) {
        this.settings.lastSyncSummary = error.message;
        await this.saveSettings();
        this.debugLog.write("sync.conflicts", {
          count: error.conflicts.length,
          conflicts: error.conflicts,
        });
        progressNotice?.hide();
        this.setPendingConflicts(error.conflicts);
        this.openConflictModal(error.conflicts);
        await this.refreshPostOperationIndicators();
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.settings.lastSyncSummary = `Failed: ${message}`;
      await this.saveSettings();
      this.debugLog.write("sync.failed", { message });
      progressNotice?.hide();
      new Notice(`Octosync failed: ${message}`, 8000);
      console.error("Octosync failed", error);
      await this.refreshPostOperationIndicators();
    }
  }

  private async runSimulation(): Promise<void> {
    try {
      this.debugLog.write("simulation.start", {
        owner: this.settings.owner,
        repo: this.settings.repo,
        branch: this.settings.branch,
      });

      const summary = await this.createSyncManager().planSync();
      const message = `Simulation: ${formatSummary(summary)}`;
      this.settings.lastSyncSummary = message;
      await this.saveSettings();
      this.debugLog.write("simulation.complete", summary);
      new Notice(message, 10000);
      await this.refreshPostOperationIndicators();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.lastSyncSummary = `Simulation failed: ${message}`;
      await this.saveSettings();
      this.debugLog.write("simulation.failed", { message });
      new Notice(`Octosync simulation failed: ${message}`, 8000);
      console.error("Octosync simulation failed", error);
      await this.refreshPostOperationIndicators();
    }
  }

  private async runConflictResolution(
    paths: string[],
    resolution: ConflictResolution,
  ): Promise<void> {
    try {
      this.debugLog.write("conflict-resolution.start", {
        resolution,
        count: paths.length,
        paths,
      });
      const summary = await this.createSyncManager().resolveConflicts(paths, resolution);
      this.clearPendingConflicts();
      this.settings.lastSyncCompletedAt = Date.now();
      this.settings.lastSyncSummary = formatSummary(summary);
      await this.saveSettings();
      this.debugLog.write("conflict-resolution.complete", summary);
      notifySummary(summary);
      this.dirtyLocalPaths.clear();
      await this.refreshPostOperationIndicators();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.lastSyncSummary = `Conflict resolution failed: ${message}`;
      await this.saveSettings();
      this.debugLog.write("conflict-resolution.failed", { message });
      new Notice(`Octosync conflict resolution failed: ${message}`, 8000);
      console.error("Octosync conflict resolution failed", error);
      await this.refreshPostOperationIndicators();
    }
  }

  private async refreshPostOperationIndicators(): Promise<void> {
    if (this.settings.localChangeIndicatorEnabled) {
      await this.refreshLocalChangeIndicator(true);
    }

    if (this.shouldPollRemoteChanges()) {
      await this.refreshRemoteChangeIndicator();
    } else {
      this.hasRemoteChangesToSync = false;
      this.updateSyncUiState();
    }
  }

  private setPendingConflicts(conflicts: string[]): void {
    this.pendingConflictPaths = [...conflicts].sort();
    this.updateSyncUiState();
  }

  private clearPendingConflicts(): void {
    this.pendingConflictPaths = null;
    this.conflictModal = null;
    this.updateSyncUiState();
  }

  private openConflictModal(conflicts: string[]): void {
    if (this.conflictModal) {
      this.conflictModal.open();
      return;
    }

    this.conflictModal = new ConflictResolutionModal(this, conflicts, () => {
      this.conflictModal = null;
    });
    this.conflictModal.open();
  }

  private async loadPluginData(): Promise<OctosyncPluginData> {
    const data = await this.loadData() as OctosyncPluginData | null | undefined;
    return data ?? {};
  }

  private async savePluginData(patch: OctosyncPluginData): Promise<void> {
    const data = await this.loadPluginData();
    await this.saveData({
      ...data,
      ...patch,
    });
  }
}

class SyncConfirmationModal extends Modal {
  private resolve!: (confirmed: boolean) => void;
  private resolved = false;

  constructor(
    plugin: OctosyncPlugin,
    private readonly summary: SyncSummary,
  ) {
    super(plugin.app);
  }

  confirm(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText("Confirm Octosync sync");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      cls: "octosync-modal-copy",
      text: "Octosync planned the sync without changing files. Review the summary before applying it.",
    });

    const summaryEl = this.contentEl.createEl("div", {
      cls: "octosync-sync-plan-summary",
    });

    for (const item of getSummaryItems(this.summary)) {
      const row = summaryEl.createDiv({ cls: "octosync-sync-plan-row" });
      row.createSpan({ text: item.label });
      row.createSpan({ text: String(item.value) });
    }

    const actions = this.contentEl.createDiv({ cls: "octosync-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const syncButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Sync now",
    });

    cancelButton.addEventListener("click", () => {
      this.closeWithResult(false);
    });
    syncButton.addEventListener("click", () => {
      this.closeWithResult(true);
    });
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(false);
    }

    this.contentEl.empty();
  }

  private closeWithResult(confirmed: boolean): void {
    this.resolved = true;
    this.resolve(confirmed);
    this.close();
  }
}

function getSummaryItems(summary: SyncSummary): Array<{
  label: string;
  value: number;
}> {
  return [
    { label: "Upload files", value: summary.uploaded },
    { label: "Download files", value: summary.downloaded },
    { label: "Delete local files", value: summary.deletedLocal },
    { label: "Delete remote files", value: summary.deletedRemote },
    { label: "Upload empty folders", value: summary.foldersUploaded },
    { label: "Download empty folders", value: summary.foldersDownloaded },
    { label: "Delete local folders", value: summary.foldersDeletedLocal },
    { label: "Delete remote folders", value: summary.foldersDeletedRemote },
  ];
}

function getRibbonLabel(syncing: boolean, hasLocalChanges: boolean, hasRemoteChanges: boolean): string {
  if (syncing) {
    return "Octosync is syncing";
  }

  if (hasLocalChanges && hasRemoteChanges) {
    return "Octosync has local vault changes and remote GitHub changes to sync";
  }

  if (hasLocalChanges) {
    return "Octosync has local vault changes to sync. This indicator does not check GitHub.";
  }

  if (hasRemoteChanges) {
    return "Octosync found remote GitHub changes. Local changes are checked separately.";
  }

  return "Sync with Octosync";
}

function formatSyncProgress(progress: SyncProgress): string {
  return [
    "Octosync is syncing...",
    `${formatOperationLabel(progress.operation)} ${truncatePath(progress.path)}`,
  ].join("\n");
}

function formatOperationLabel(operation: SyncProgress["operation"]): string {
  switch (operation) {
    case "upload":
      return "Uploading";
    case "download":
      return "Downloading";
    case "deleteRemote":
      return "Deleting from GitHub";
    case "deleteLocal":
      return "Deleting locally";
    case "uploadFolder":
      return "Uploading folder";
    case "downloadFolder":
      return "Creating folder";
    case "deleteRemoteFolder":
      return "Deleting folder from GitHub";
    case "deleteLocalFolder":
      return "Deleting local folder";
  }
}

function truncatePath(path: string): string {
  const maxLength = 72;
  if (path.length <= maxLength) {
    return path;
  }

  return `...${path.slice(path.length - maxLength + 3)}`;
}

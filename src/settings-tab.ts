import { App, ButtonComponent, DropdownComponent, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type OctosyncPlugin from "./main";
import { createAuthProvider } from "./auth";
import { GitHubClient } from "./github";
import type { GitHubBranch, GitHubRepository } from "./types";

const SUPPORT_LINKS = {
  githubSponsors: "https://github.com/sponsors/grumpydev",
  koFi: "https://ko-fi.com/grumpydev",
};

export class OctosyncSettingTab extends PluginSettingTab {
  private repos: GitHubRepository[] = [];
  private branches: GitHubBranch[] = [];
  private statusEl: HTMLElement | null = null;
  private editingRepositoryConfig = false;

  constructor(app: App, private readonly plugin: OctosyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.addHeader(containerEl);
    this.statusEl = containerEl.createDiv({ cls: "octosync-status" });
    this.setStatus(this.getInitialStatus());

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Use a fine-grained token restricted to one repository with Contents read/write.")
      .addText((text) => {
        text
          .setPlaceholder("github_pat_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });

        text.inputEl.type = "password";
      });

    if (this.hasSavedRepositoryConfig() && !this.editingRepositoryConfig && this.repos.length === 0) {
      this.addCurrentRepositorySettings(containerEl);
    } else {
      this.addRepositoryLoader(containerEl);
      this.addRepositorySettings(containerEl);
    }

    this.addSyncSettings(containerEl);
    this.addObsidianSyncSettings(containerEl);
    this.addDebugSettings(containerEl);
    this.addActions(containerEl);
    this.addSupport(containerEl);
  }

  private addHeader(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("GitHub sync")
      .setHeading();

    const header = containerEl.createDiv({ cls: "octosync-settings-header" });
    const logo = header.createDiv({ cls: "octosync-settings-logo" });
    logo.setAttr("aria-hidden", "true");
    setIcon(logo, "octosync-logo");

    header.createDiv({
      cls: "octosync-settings-tagline",
      text: "GitHub sync for desktop and mobile vaults.",
    });
  }

  private addCurrentRepositorySettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Repository")
      .setDesc(`${this.plugin.settings.owner}/${this.plugin.settings.repo}`)
      .addButton((button) => {
        button
          .setButtonText("Change")
          .setCta()
          .onClick(async () => {
            this.editingRepositoryConfig = true;
            await this.loadRepositories(button);
          });
      });

    new Setting(containerEl)
      .setName("Branch")
      .setDesc(this.plugin.settings.branch);
  }

  private addRepositoryLoader(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Repositories")
      .setDesc("Load repositories available to the token.")
      .addButton((button) => {
        button
          .setButtonText(this.repos.length > 0 ? "Reload" : "Load")
          .setCta()
          .onClick(async () => {
            this.editingRepositoryConfig = true;
            await this.loadRepositories(button);
          });
      });
  }

  private addRepositorySettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Owner")
      .setDesc("Derived from repositories returned by GitHub.")
      .addDropdown((dropdown) => {
        const owners = Array.from(new Set(this.repos.map((repo) => repo.owner.login))).sort();
        hydrateDropdown(dropdown, owners, this.plugin.settings.owner, "Load repositories first");
        dropdown.onChange(async (value) => {
          this.plugin.settings.owner = value;
          this.selectDefaultRepositoryForOwner();
          await this.plugin.saveSettings();
          await this.loadBranches();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("Only repositories visible to the configured token are shown.")
      .addDropdown((dropdown) => {
        const repos = this.repos
          .filter((repo) => !this.plugin.settings.owner || repo.owner.login === this.plugin.settings.owner)
          .map((repo) => repo.name)
          .sort();

        hydrateDropdown(dropdown, repos, this.plugin.settings.repo, "Select an owner first");
        dropdown.onChange(async (value) => {
          this.plugin.settings.repo = value;
          this.plugin.settings.branch = this.getSelectedRepository()?.default_branch ?? "";
          await this.plugin.saveSettings();
          await this.loadBranches();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Loaded from the selected repository.")
      .addDropdown((dropdown) => {
        hydrateDropdown(
          dropdown,
          this.getBranchDropdownValues(),
          this.plugin.settings.branch,
          "Select a repository first",
        );
        dropdown.onChange(async (value) => {
          this.plugin.settings.branch = value;
          await this.plugin.saveSettings();
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Refresh")
          .onClick(async () => {
            await this.loadBranches(button);
            this.display();
          });
      });
  }

  private addSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc(
        this.plugin.settings.syncMode === "automatic"
          ? "Automatic sync can run on startup or on an interval."
          : "Manual sync runs only when you use the ribbon, command, or sync button. The ribbon indicator only checks for local vault changes.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("automatic", "Automatic")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value === "automatic" ? "automatic" : "manual";
            await this.plugin.saveSettings();
            this.plugin.configureIntervalSync();
            this.plugin.configureChangeIndicators();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Unsynced local changes indicator")
      .setDesc(
        "Shows a ribbon badge when local vault files differ from Octosync metadata. It watches Obsidian vault events and does not contact GitHub.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.localChangeIndicatorEnabled)
          .onChange(async (value) => {
            this.plugin.settings.localChangeIndicatorEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.configureChangeIndicators();
            this.display();
          });
      });

    if (this.plugin.settings.localChangeIndicatorEnabled) {
      new Setting(containerEl)
        .setName("Periodic full local scan")
        .setDesc(
          "Every few minutes, re-scan local files to catch external edits that Obsidian events may have missed. This is local-only and does not check GitHub.",
        )
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.localChangePeriodicFullScan)
            .onChange(async (value) => {
              this.plugin.settings.localChangePeriodicFullScan = value;
              await this.plugin.saveSettings();
              this.plugin.configureChangeIndicators();
            });
        });
    }

    if (this.plugin.settings.syncMode === "manual") {
      new Setting(containerEl)
        .setName("Remote changes indicator")
        .setDesc(
          "Periodically checks GitHub for remote changes and marks the ribbon when a manual sync may be needed. This uses network requests and never applies changes.",
        )
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.remoteChangeIndicatorEnabled)
            .onChange(async (value) => {
              this.plugin.settings.remoteChangeIndicatorEnabled = value;
              await this.plugin.saveSettings();
              this.plugin.configureChangeIndicators();
              this.display();
            });
        });

      if (this.plugin.settings.remoteChangeIndicatorEnabled) {
        new Setting(containerEl)
          .setName("Remote check interval")
          .setDesc("Minutes between GitHub checks in manual mode. Use 0 to disable polling.")
          .addText((text) => {
            text
              .setPlaceholder("15")
              .setValue(String(this.plugin.settings.remoteChangeCheckIntervalMinutes))
              .onChange(async (value) => {
                const parsed = Number.parseInt(value, 10);
                this.plugin.settings.remoteChangeCheckIntervalMinutes = Number.isFinite(parsed)
                  ? Math.max(0, parsed)
                  : 0;
                await this.plugin.saveSettings();
                this.plugin.configureChangeIndicators();
              });

            text.inputEl.type = "number";
            text.inputEl.min = "0";
            text.inputEl.step = "1";
          });
      }
    }

    if (this.plugin.settings.syncMode === "automatic") {
      new Setting(containerEl)
        .setName("Sync on startup")
        .setDesc("Run sync when Obsidian loads this plugin.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.syncOnStartup)
            .onChange(async (value) => {
              this.plugin.settings.syncOnStartup = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Sync interval")
        .setDesc("Minutes between automatic syncs. Use 0 to disable interval sync.")
        .addText((text) => {
          text
            .setPlaceholder("0")
            .setValue(String(this.plugin.settings.syncIntervalMinutes))
            .onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              this.plugin.settings.syncIntervalMinutes = Number.isFinite(parsed)
                ? Math.max(0, parsed)
                : 0;
              await this.plugin.saveSettings();
              this.plugin.configureIntervalSync();
            });

          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.inputEl.step = "1";
        });
    } else {
      new Setting(containerEl)
        .setName("Confirm before sync")
        .setDesc("Build the sync plan first, then ask before applying changes.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.confirmBeforeManualSync)
            .onChange(async (value) => {
              this.plugin.settings.confirmBeforeManualSync = value;
              await this.plugin.saveSettings();
            });
          });
    }

    new Setting(containerEl)
      .setName("Last sync")
      .setDesc(this.plugin.settings.lastSyncSummary || "No completed sync yet.");
  }

  private addObsidianSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Obsidian config sync")
      .setHeading();

    new Setting(containerEl)
      .setName("Sync community plugins")
      .setDesc(
        "Sync the .obsidian/plugins folder and community-plugins.json. Enables plugins and their data to roam across devices.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncCommunityPlugins)
          .onChange(async (value) => {
            this.plugin.settings.syncCommunityPlugins = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync themes")
      .setDesc("Sync the .obsidian/themes folder so custom themes are available on all devices.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncThemes)
          .onChange(async (value) => {
            this.plugin.settings.syncThemes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync CSS snippets")
      .setDesc("Sync the .obsidian/snippets folder so custom CSS snippets are available on all devices.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncSnippets)
          .onChange(async (value) => {
            this.plugin.settings.syncSnippets = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc(
        "One path or filename per line. A pattern with a / is matched as a path prefix; a plain filename (no /) matches that filename anywhere in the vault. " +
        "Known credential files such as secure-credentials.dat are always excluded from plugin sync regardless of this list.",
      );

    const excludeArea = containerEl.createEl("textarea", {
      cls: "octosync-exclude-paths",
    });
    excludeArea.rows = 4;
    excludeArea.placeholder = ".obsidian/plugins/some-plugin/data.json";
    excludeArea.value = this.plugin.settings.syncExcludePaths.join("\n");
    excludeArea.addEventListener("change", async () => {
      this.plugin.settings.syncExcludePaths = excludeArea.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      await this.plugin.saveSettings();
    });
  }

  private addDebugSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Store a small rolling sync log in plugin data. Tokens are redacted.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (!this.plugin.settings.debugLogging && this.plugin.getDebugLogCount() === 0) {
      return;
    }

    new Setting(containerEl)
      .setName("Debug log")
      .setDesc(`${this.plugin.getDebugLogCount()} entries. The log is shown below and can be selected manually.`)
      .addButton((button) => {
        button
          .setButtonText("Clear")
          .onClick(async () => {
            await this.plugin.clearDebugLog();
            new Notice("Octosync debug log cleared.");
            this.display();
          });
      });

    const preview = containerEl.createEl("textarea", {
      cls: "octosync-debug-log",
    });
    preview.readOnly = true;
    preview.value = this.plugin.getDebugLogText();
  }

  private addActions(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Simulate sync")
      .setDesc(
        "Scans the vault and GitHub, builds the sync plan, and reports what would happen without changing files, metadata, or GitHub.",
      )
      .addButton((button) => {
        button
          .setButtonText(this.plugin.isSyncing() ? "Busy..." : "Simulate")
          .setDisabled(this.plugin.isSyncing())
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Simulating...");
            await this.plugin.simulateSync();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc("Run a sync now.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.isSyncing() ? "Syncing..." : "Sync now")
          .setCta()
          .setDisabled(this.plugin.isSyncing())
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Syncing...");
            await this.plugin.syncNow();
            this.display();
          });
      });
  }

  private addSupport(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Support Octosync")
      .setDesc(
        "Octosync is free to use. If it saves you time, you can support ongoing development with a voluntary tip.",
      )
      .addButton((button) => {
        button
          .setButtonText("GitHub Sponsors")
          .onClick(() => {
            window.open(SUPPORT_LINKS.githubSponsors, "_blank", "noopener,noreferrer");
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Ko-fi")
          .onClick(() => {
            window.open(SUPPORT_LINKS.koFi, "_blank", "noopener,noreferrer");
          });
      });
  }

  private async loadRepositories(button?: ButtonComponent): Promise<void> {
    try {
      button?.setDisabled(true);
      this.setStatus("Loading repositories...");
      const client = new GitHubClient(createAuthProvider(this.plugin.settings));
      this.repos = await client.listRepositories();
      this.selectDefaultRepository();
      await this.plugin.saveSettings();
      await this.loadBranches();
      this.setStatus(`Loaded ${this.repos.length} repositories.`, "success");
      this.display();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      button?.setDisabled(false);
    }
  }

  private async loadBranches(button?: ButtonComponent): Promise<void> {
    if (!this.plugin.settings.owner || !this.plugin.settings.repo) {
      this.branches = [];
      return;
    }

    try {
      button?.setDisabled(true);
      this.setStatus("Loading branches...");
      const client = new GitHubClient(createAuthProvider(this.plugin.settings));
      this.branches = await client.listBranches(
        this.plugin.settings.owner,
        this.plugin.settings.repo,
      );
      const emptyRepositoryBranch = this.selectDefaultBranch();
      await this.plugin.saveSettings();
      this.setStatus(
        emptyRepositoryBranch
          ? `Repository has no branches yet. Octosync will initialize ${emptyRepositoryBranch} on first sync.`
          : `Loaded ${this.branches.length} branches.`,
        "success",
      );
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      button?.setDisabled(false);
    }
  }

  private selectDefaultRepository(): void {
    if (this.repos.length === 0) {
      this.plugin.settings.owner = "";
      this.plugin.settings.repo = "";
      this.plugin.settings.branch = "";
      return;
    }

    const owners = new Set(this.repos.map((repo) => repo.owner.login));

    if (!this.plugin.settings.owner || !owners.has(this.plugin.settings.owner)) {
      this.plugin.settings.owner = Array.from(owners).sort()[0];
    }

    this.selectDefaultRepositoryForOwner();
  }

  private selectDefaultRepositoryForOwner(): void {
    const repos = this.repos
      .filter((repo) => repo.owner.login === this.plugin.settings.owner)
      .sort((left, right) => left.name.localeCompare(right.name));

    if (repos.length === 0) {
      this.plugin.settings.repo = "";
      this.plugin.settings.branch = "";
      return;
    }

    const selectedRepo = repos.find((repo) => repo.name === this.plugin.settings.repo) ?? repos[0];
    this.plugin.settings.repo = selectedRepo.name;
    this.plugin.settings.branch = selectedRepo.default_branch;
  }

  private selectDefaultBranch(): string | null {
    if (this.branches.length === 0) {
      this.plugin.settings.branch = this.getSelectedRepository()?.default_branch ?? "";
      return this.plugin.settings.branch || null;
    }

    const branchNames = this.branches.map((branch) => branch.name);

    if (!branchNames.includes(this.plugin.settings.branch)) {
      const defaultBranch = this.getSelectedRepository()?.default_branch;
      this.plugin.settings.branch =
        defaultBranch && branchNames.includes(defaultBranch) ? defaultBranch : branchNames.sort()[0];
    }

    return null;
  }

  private getBranchDropdownValues(): string[] {
    const branchNames = this.branches.map((branch) => branch.name).sort();

    if (branchNames.length === 0 && this.plugin.settings.branch) {
      return [this.plugin.settings.branch];
    }

    return branchNames;
  }

  private getSelectedRepository(): GitHubRepository | undefined {
    return this.repos.find(
      (repo) =>
        repo.owner.login === this.plugin.settings.owner &&
        repo.name === this.plugin.settings.repo,
    );
  }

  private setStatus(message: string, kind?: "success" | "error"): void {
    if (!this.statusEl) {
      return;
    }

    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-success", kind === "success");
    this.statusEl.toggleClass("is-error", kind === "error");
  }

  private hasSavedRepositoryConfig(): boolean {
    return Boolean(
      this.plugin.settings.owner &&
      this.plugin.settings.repo &&
      this.plugin.settings.branch,
    );
  }

  private getInitialStatus(): string {
    if (this.hasSavedRepositoryConfig()) {
      return `Configured for ${this.plugin.settings.owner}/${this.plugin.settings.repo} on ${this.plugin.settings.branch}.`;
    }

    return "Connect a fine-grained GitHub token, then load repositories.";
  }

}

function hydrateDropdown(
  dropdown: DropdownComponent,
  values: string[],
  selected: string,
  placeholder: string,
): void {
  if (values.length === 0) {
    dropdown.addOption("", placeholder);
    dropdown.setValue("");
    dropdown.setDisabled(true);
    return;
  }

  for (const value of values) {
    dropdown.addOption(value, value);
  }

  dropdown.setValue(values.includes(selected) ? selected : values[0]);
}

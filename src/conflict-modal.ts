import { Modal, Setting } from "obsidian";
import type OctosyncPlugin from "./main";
import type { ConflictResolution } from "./sync";

export class ConflictResolutionModal extends Modal {
  constructor(
    private readonly plugin: OctosyncPlugin,
    private readonly conflicts: string[],
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Octosync conflicts");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      cls: "octosync-modal-copy",
      text: `${this.conflicts.length} file${this.conflicts.length === 1 ? "" : "s"} changed both locally and on GitHub.`,
    });

    const list = this.contentEl.createEl("div", { cls: "octosync-conflict-list" });

    for (const path of this.conflicts) {
      list.createDiv({ cls: "octosync-conflict-path", text: path });
    }

    new Setting(this.contentEl)
      .setName("Keep local")
      .setDesc("Upload the local version of every conflicted file to GitHub.")
      .addButton((button) => {
        button
          .setButtonText("Keep local")
          .setCta()
          .onClick(async () => {
            await this.resolve("local");
          });
      });

    new Setting(this.contentEl)
      .setName("Keep remote")
      .setDesc("Replace local conflicted files with the versions from GitHub.")
      .addButton((button) => {
        button
          .setButtonText("Keep remote")
          .onClick(async () => {
            await this.resolve("remote");
          });
      });

    new Setting(this.contentEl)
      .setName("Keep both")
      .setDesc("Save each local file as a local conflict copy, then replace the original with GitHub.")
      .addButton((button) => {
        button
          .setButtonText("Keep both")
          .onClick(async () => {
            await this.resolve("both");
          });
      });

    new Setting(this.contentEl)
      .setName("Decide later")
      .setDesc("Leave files unchanged and close this dialog.")
      .addButton((button) => {
        button
          .setButtonText("Close")
          .onClick(() => {
            this.close();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async resolve(resolution: ConflictResolution): Promise<void> {
    this.close();
    await this.plugin.resolveConflicts(this.conflicts, resolution);
  }
}

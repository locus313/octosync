import type { SyncFileRecord, SyncFolderRecord, SyncMetadata } from "./types";

const METADATA_VERSION = 1;

export class MetadataStore {
  private metadata: SyncMetadata = {
    version: METADATA_VERSION,
    files: {},
    folders: {},
  };

  constructor(
    private readonly loadData: () => Promise<unknown>,
    private readonly saveData: (data: unknown) => Promise<void>,
  ) {}

  get data(): SyncMetadata {
    return this.metadata;
  }

  restore(data: SyncMetadata): void {
    this.metadata = {
      version: data.version,
      files: Object.fromEntries(
        Object.entries(data.files).map(([path, record]) => [path, { ...record }]),
      ),
      folders: Object.fromEntries(
        Object.entries(data.folders).map(([path, record]) => [path, { ...record }]),
      ),
    };
  }

  async load(): Promise<void> {
    const loaded = await this.loadData();

    if (isSyncMetadata(loaded)) {
      this.metadata = {
        ...loaded,
        folders: loaded.folders ?? {},
      };
      return;
    }

    this.metadata = {
      version: METADATA_VERSION,
      files: {},
      folders: {},
    };
  }

  async save(): Promise<void> {
    await this.saveData(this.metadata);
  }

  get(path: string): SyncFileRecord | undefined {
    return this.metadata.files[path];
  }

  ensure(path: string, now: number): SyncFileRecord {
    const existing = this.metadata.files[path];

    if (existing) {
      return existing;
    }

    const record: SyncFileRecord = {
      path,
      sha: null,
      dirty: false,
      lastModified: now,
      deleted: false,
    };

    this.metadata.files[path] = record;
    return record;
  }

  update(path: string, changes: Partial<Omit<SyncFileRecord, "path">>, now: number): void {
    const record = this.ensure(path, now);
    Object.assign(record, changes, {
      path,
      lastModified: changes.lastModified ?? now,
    });
  }

  remove(path: string): void {
    delete this.metadata.files[path];
  }

  getFolder(path: string): SyncFolderRecord | undefined {
    return this.metadata.folders[path];
  }

  ensureFolder(path: string, now: number): SyncFolderRecord {
    const existing = this.metadata.folders[path];

    if (existing) {
      return existing;
    }

    const record: SyncFolderRecord = {
      path,
      markerSha: null,
      lastModified: now,
      deleted: false,
    };

    this.metadata.folders[path] = record;
    return record;
  }

  updateFolder(
    path: string,
    changes: Partial<Omit<SyncFolderRecord, "path">>,
    now: number,
  ): void {
    const record = this.ensureFolder(path, now);
    Object.assign(record, changes, {
      path,
      lastModified: changes.lastModified ?? now,
    });
  }

  removeFolder(path: string): void {
    delete this.metadata.folders[path];
  }
}

function isSyncMetadata(value: unknown): value is SyncMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SyncMetadata>;
  return candidate.version === METADATA_VERSION && typeof candidate.files === "object";
}

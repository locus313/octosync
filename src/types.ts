export type AuthMode = "pat";
export type SyncMode = "manual" | "automatic";

export interface OctosyncSettings {
  authMode: AuthMode;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  syncMode: SyncMode;
  confirmBeforeManualSync: boolean;
  localChangeIndicatorEnabled: boolean;
  localChangePeriodicFullScan: boolean;
  remoteChangeIndicatorEnabled: boolean;
  remoteChangeCheckIntervalMinutes: number;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  syncCommunityPlugins: boolean;
  syncThemes: boolean;
  syncSnippets: boolean;
  syncExcludePaths: string[];
  debugLogging: boolean;
  lastSyncStartedAt: number | null;
  lastSyncCompletedAt: number | null;
  lastSyncSummary: string;
}

export interface SyncFileRecord {
  path: string;
  sha: string | null;
  dirty: boolean;
  lastModified: number;
  deleted: boolean;
}

export interface SyncFolderRecord {
  path: string;
  markerSha: string | null;
  lastModified: number;
  deleted: boolean;
}

export interface SyncMetadata {
  version: 1;
  files: Record<string, SyncFileRecord>;
  folders: Record<string, SyncFolderRecord>;
}

export interface GitHubRepository {
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  default_branch: string;
  private: boolean;
  permissions?: {
    push?: boolean;
  };
}

export interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
  };
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GitHubTree {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

export interface GitHubBlob {
  sha: string;
  content: string;
  encoding: "base64" | "utf-8";
}

export interface RemoteFile {
  path: string;
  sha: string;
  size: number;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  foldersUploaded: number;
  foldersDownloaded: number;
  foldersDeletedLocal: number;
  foldersDeletedRemote: number;
  conflicts: string[];
}

export const DEFAULT_SETTINGS: OctosyncSettings = {
  authMode: "pat",
  token: "",
  owner: "",
  repo: "",
  branch: "",
  syncMode: "manual",
  confirmBeforeManualSync: true,
  localChangeIndicatorEnabled: true,
  localChangePeriodicFullScan: true,
  remoteChangeIndicatorEnabled: false,
  remoteChangeCheckIntervalMinutes: 15,
  syncOnStartup: false,
  syncIntervalMinutes: 0,
  syncCommunityPlugins: false,
  syncThemes: false,
  syncSnippets: false,
  syncExcludePaths: [],
  debugLogging: false,
  lastSyncStartedAt: null,
  lastSyncCompletedAt: null,
  lastSyncSummary: "",
};

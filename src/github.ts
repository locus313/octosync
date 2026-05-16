import { requestUrl } from "obsidian";
import type {
  GitHubBlob,
  GitHubBranch,
  GitHubRepository,
  GitHubTree,
  RemoteFile,
} from "./types";
import type { AuthProvider } from "./auth";
import type { DebugLogSink } from "./debug-log";
import { bytesToBase64 } from "./hash";

interface GitHubCommit {
  sha: string;
  tree: {
    sha: string;
  };
}

interface GitHubRef {
  object: {
    sha: string;
  };
}

interface CreateTreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

interface CreateTreeResponse {
  sha: string;
}

interface CreateCommitResponse {
  sha: string;
}

interface CreateFileResponse {
  commit: {
    sha: string;
  };
}

const BOOTSTRAP_PATH = ".octosync/bootstrap.md";
const BOOTSTRAP_CONTENT =
  "Octosync bootstrap file for an initially empty GitHub repository.\n";
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class GitHubClient {
  private readonly apiBase = "https://api.github.com";

  constructor(
    private readonly auth: AuthProvider,
    private readonly debugLog?: DebugLogSink,
  ) {}

  async listRepositories(): Promise<GitHubRepository[]> {
    const repos = await this.paginate<GitHubRepository>(
      "/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100",
    );

    return repos.filter((repo) => repo.permissions?.push !== false);
  }

  async listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    try {
      return await this.paginate<GitHubBranch>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
      );
    } catch (error) {
      if (isEmptyRepositoryError(error)) {
        return [];
      }

      throw error;
    }
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch> {
    const ref = await this.request<GitHubRef>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodePath(branch)}`,
    );

    return {
      name: branch,
      commit: {
        sha: ref.object.sha,
      },
    };
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`,
    );
  }

  async getTree(owner: string, repo: string, treeSha: string): Promise<GitHubTree> {
    return this.request<GitHubTree>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    );
  }

  async getBlob(owner: string, repo: string, sha: string): Promise<GitHubBlob> {
    return this.request<GitHubBlob>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`,
    );
  }

  async createBlob(owner: string, repo: string, contentBase64: string): Promise<{ sha: string }> {
    return this.request<{ sha: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
      {
        method: "POST",
        body: JSON.stringify({
          content: contentBase64,
          encoding: "base64",
        }),
      },
    );
  }

  async createTree(
    owner: string,
    repo: string,
    baseTreeSha: string,
    tree: CreateTreeEntry[],
  ): Promise<CreateTreeResponse> {
    const body: { base_tree?: string; tree: CreateTreeEntry[] } = {
      tree,
    };

    if (baseTreeSha !== EMPTY_TREE_SHA) {
      body.base_tree = baseTreeSha;
    }

    return this.request<CreateTreeResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  async createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parentSha: string,
  ): Promise<CreateCommitResponse> {
    return this.request<CreateCommitResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message,
          tree: treeSha,
          parents: [parentSha],
        }),
      },
    );
  }

  async updateBranchRef(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          sha,
          force: false,
        }),
      },
    );
  }

  async createBranchRef(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha,
        }),
      },
    );
  }

  async getRemoteFiles(owner: string, repo: string, branch: string): Promise<{
    commitSha: string;
    treeSha: string;
    files: Map<string, RemoteFile>;
  }> {
    const branchInfo = await this.getOrBootstrapBranch(owner, repo, branch);
    const commit = await this.getCommit(owner, repo, branchInfo.commit.sha);
    const treeSha = commit.tree?.sha;

    if (!treeSha) {
      throw new Error("GitHub commit response did not include a tree SHA.");
    }

    if (treeSha === EMPTY_TREE_SHA) {
      return {
        commitSha: commit.sha,
        treeSha,
        files: new Map(),
      };
    }

    const tree = await this.getTree(owner, repo, treeSha);

    if (tree.truncated) {
      throw new Error("GitHub returned a truncated tree. Narrow the vault scope before syncing.");
    }

    const files = new Map<string, RemoteFile>();

    for (const entry of tree.tree) {
      if (entry.type !== "blob") {
        continue;
      }

      files.set(entry.path, {
        path: entry.path,
        sha: entry.sha,
        size: entry.size ?? 0,
      });
    }

    return {
      commitSha: commit.sha,
      treeSha,
      files,
    };
  }

  private async getOrBootstrapBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GitHubBranch> {
    try {
      return await this.getBranch(owner, repo, branch);
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 404) {
        throw error;
      }

      const branches = await this.listBranches(owner, repo);

      if (branches.length > 0) {
        throw error;
      }

      return this.bootstrapEmptyRepository(owner, repo, branch);
    }
  }

  private async bootstrapEmptyRepository(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GitHubBranch> {
    const repository = await this.getRepository(owner, repo);
    const bootstrap = await this.createBootstrapFile(owner, repo);
    const defaultBranch = repository.default_branch || branch;

    if (branch !== defaultBranch) {
      await this.createBranchRef(owner, repo, branch, bootstrap.commit.sha);
    }

    this.debugLog?.("github.bootstrap-empty-repo", {
      owner,
      repo,
      branch,
    });

    return {
      name: branch,
      commit: {
        sha: bootstrap.commit.sha,
      },
    };
  }

  private async createBootstrapFile(owner: string, repo: string): Promise<CreateFileResponse> {
    return this.request<CreateFileResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(BOOTSTRAP_PATH)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: "Initialize empty repository for Octosync",
          content: bytesToBase64(new TextEncoder().encode(BOOTSTRAP_CONTENT).buffer),
        }),
      },
    );
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let nextPath: string | null = path;

    while (nextPath) {
      const response = await this.requestWithHeaders<T[]>(nextPath);
      results.push(...response.body);
      nextPath = getNextPath(response.headers.link ?? response.headers.Link);
    }

    return results;
  }

  private async request<T = unknown>(
    path: string,
    options: { method?: string; body?: string } = {},
  ): Promise<T> {
    const response = await this.requestWithHeaders<T>(path, options);
    return response.body;
  }

  private async requestWithHeaders<T>(
    path: string,
    options: { method?: string; body?: string } = {},
  ): Promise<{ body: T; headers: Record<string, string> }> {
    const method = options.method ?? "GET";
    const response = await requestUrl({
      url: `${this.apiBase}${method === "GET" ? withCacheBuster(path) : path}`,
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: this.auth.getAuthorizationHeader(),
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        Pragma: "no-cache",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: options.body,
      throw: false,
    });
    this.debugLog?.("github.request", {
      method: options.method ?? "GET",
      path,
      status: response.status,
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.text || `GitHub request failed with ${response.status}`;
      this.debugLog?.("github.error", {
        method: options.method ?? "GET",
        path,
        status: response.status,
        message,
      });
      throw new GitHubRequestError(message, response.status);
    }

    return {
      body: response.json as T,
      headers: response.headers,
    };
  }
}

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

function getNextPath(linkHeader: string | undefined): string | null {
  if (!linkHeader) {
    return null;
  }

  const next = linkHeader
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));

  if (!next) {
    return null;
  }

  const match = next.match(/<https:\/\/api\.github\.com([^>]+)>/);
  return match?.[1] ?? null;
}

function withCacheBuster(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}_octosync=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isEmptyRepositoryError(error: unknown): boolean {
  return (
    error instanceof GitHubRequestError &&
    error.status === 409 &&
    /empty/i.test(error.message)
  );
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

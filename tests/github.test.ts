import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRequestUrlMock } from "obsidian";
import { GitHubClient, GitHubRequestError } from "../src/github";
import type { AuthProvider } from "../src/auth";

const auth: AuthProvider = {
  getAuthorizationHeader: () => "Bearer test-token",
};
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface RequestCall {
  url: string;
  method?: string;
  body?: string;
}

describe("GitHubClient", () => {
  const calls: RequestCall[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    setRequestUrlMock(null);
  });

  it("treats an empty repository branch listing as no branches", async () => {
    setRequestUrlMock(async (request) => {
      calls.push(request);
      return response(409, { message: "Git Repository is empty." });
    });

    await expect(new GitHubClient(auth).listBranches("owner", "repo")).resolves.toEqual([]);
  });

  it("bootstraps an empty repository before reading remote files", async () => {
    setRequestUrlMock(async (request) => {
      calls.push(request);

      if (apiPath(request.url).endsWith("/git/ref/heads/main")) {
        return response(404, { message: "Branch not found" });
      }

      if (apiPath(request.url).endsWith("/branches?per_page=100")) {
        return response(409, { message: "Git Repository is empty." });
      }

      if (apiPath(request.url).endsWith("/repos/owner/repo")) {
        return response(200, {
          name: "repo",
          full_name: "owner/repo",
          owner: { login: "owner" },
          default_branch: "main",
          private: true,
        });
      }

      if (apiPath(request.url).endsWith("/contents/.octosync/bootstrap.md")) {
        expect(request.method).toBe("PUT");
        expect(JSON.parse(request.body ?? "{}")).toMatchObject({
          message: "Initialize empty repository for Octosync",
        });
        return response(201, {
          commit: {
            sha: "commit-bootstrap",
          },
        });
      }

      if (apiPath(request.url).endsWith("/git/commits/commit-bootstrap")) {
        return response(200, {
          sha: "commit-bootstrap",
          tree: {
            sha: "tree-bootstrap",
          },
        });
      }

      if (apiPath(request.url).endsWith("/git/trees/tree-bootstrap?recursive=1")) {
        return response(200, {
          sha: "tree-bootstrap",
          truncated: false,
          tree: [
            {
              path: ".octosync/bootstrap.md",
              mode: "100644",
              type: "blob",
              sha: "blob-bootstrap",
              size: 64,
            },
          ],
        });
      }

      throw new Error(`Unexpected request ${request.method ?? "GET"} ${request.url}`);
    });

    const remote = await new GitHubClient(auth).getRemoteFiles("owner", "repo", "main");

    expect(remote.commitSha).toBe("commit-bootstrap");
    expect(remote.treeSha).toBe("tree-bootstrap");
    expect(remote.files.get(".octosync/bootstrap.md")).toMatchObject({
      sha: "blob-bootstrap",
    });
    expect(calls.some((call) => apiPath(call.url).endsWith("/contents/.octosync/bootstrap.md"))).toBe(true);
  });

  it("does not bootstrap when the requested branch is missing from a non-empty repository", async () => {
    setRequestUrlMock(async (request) => {
      calls.push(request);

      if (apiPath(request.url).endsWith("/git/ref/heads/missing")) {
        return response(404, { message: "Branch not found" });
      }

      if (apiPath(request.url).endsWith("/branches?per_page=100")) {
        return response(200, [
          {
            name: "main",
            commit: {
              sha: "commit-main",
            },
          },
        ]);
      }

      throw new Error(`Unexpected request ${request.method ?? "GET"} ${request.url}`);
    });

    await expect(new GitHubClient(auth).getRemoteFiles("owner", "repo", "missing")).rejects
      .toBeInstanceOf(GitHubRequestError);
    expect(calls.some((call) => call.url.includes("/contents/"))).toBe(false);
  });

  it("treats GitHub's canonical empty tree SHA as an empty remote file set", async () => {
    setRequestUrlMock(async (request) => {
      calls.push(request);

      if (apiPath(request.url).endsWith("/git/ref/heads/empty")) {
        return response(200, {
          object: {
            sha: "commit-empty",
          },
        });
      }

      if (apiPath(request.url).endsWith("/git/commits/commit-empty")) {
        return response(200, {
          sha: "commit-empty",
          tree: {
            sha: EMPTY_TREE_SHA,
          },
        });
      }

      throw new Error(`Unexpected request ${request.method ?? "GET"} ${request.url}`);
    });

    const remote = await new GitHubClient(auth).getRemoteFiles("owner", "repo", "empty");

    expect(remote.commitSha).toBe("commit-empty");
    expect(remote.treeSha).toBe(EMPTY_TREE_SHA);
    expect(remote.files.size).toBe(0);
    expect(calls.some((call) => call.url.includes("/git/trees/"))).toBe(false);
  });

  it("omits base_tree when creating a tree from GitHub's canonical empty tree", async () => {
    setRequestUrlMock(async (request) => {
      calls.push(request);

      if (apiPath(request.url).endsWith("/git/trees")) {
        expect(request.method).toBe("POST");
        expect(JSON.parse(request.body ?? "{}")).toEqual({
          tree: [
            {
              path: "note.md",
              mode: "100644",
              type: "blob",
              sha: "blob-note",
            },
          ],
        });
        return response(201, { sha: "tree-created" });
      }

      throw new Error(`Unexpected request ${request.method ?? "GET"} ${request.url}`);
    });

    await expect(
      new GitHubClient(auth).createTree("owner", "repo", EMPTY_TREE_SHA, [
        {
          path: "note.md",
          mode: "100644",
          type: "blob",
          sha: "blob-note",
        },
      ]),
    ).resolves.toEqual({ sha: "tree-created" });
  });
});

function response(status: number, json: unknown): {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
} {
  return {
    status,
    text: JSON.stringify(json),
    json,
    headers: {},
  };
}

function apiPath(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("_octosync");
  const search = parsed.searchParams.toString();
  return `${parsed.pathname}${search ? `?${search}` : ""}`;
}

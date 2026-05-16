import { describe, expect, it } from "vitest";
import { MetadataStore } from "../src/metadata";
import type { SyncMetadata } from "../src/types";

describe("MetadataStore", () => {
  it("starts fresh when persisted data is invalid", async () => {
    const store = new MetadataStore(async () => ({ version: 99, files: {} }), async () => {});

    await store.load();

    expect(store.data).toEqual({ version: 1, files: {}, folders: {} });
  });

  it("loads existing metadata and backfills missing folders", async () => {
    const store = new MetadataStore(
      async () => ({
        version: 1,
        files: {
          "note.md": {
            path: "note.md",
            sha: "abc",
            dirty: false,
            lastModified: 10,
            deleted: false,
          },
        },
      }),
      async () => {},
    );

    await store.load();

    expect(store.get("note.md")?.sha).toBe("abc");
    expect(store.data.folders).toEqual({});
  });

  it("ensures, updates, removes, and saves file records", async () => {
    let saved: unknown;
    const store = new MetadataStore(async () => null, async (data) => {
      saved = data;
    });

    await store.load();
    expect(store.ensure("note.md", 10)).toMatchObject({
      path: "note.md",
      sha: null,
      dirty: false,
      lastModified: 10,
      deleted: false,
    });

    store.update("note.md", { sha: "abc", dirty: true }, 20);
    expect(store.get("note.md")).toMatchObject({
      path: "note.md",
      sha: "abc",
      dirty: true,
      lastModified: 20,
    });

    await store.save();
    expect(saved).toBe(store.data);

    store.remove("note.md");
    expect(store.get("note.md")).toBeUndefined();
  });

  it("manages folder marker records", async () => {
    const store = new MetadataStore(async () => null, async () => {});

    await store.load();
    store.updateFolder("empty", { markerSha: "marker", deleted: false }, 30);

    expect(store.getFolder("empty")).toMatchObject({
      path: "empty",
      markerSha: "marker",
      lastModified: 30,
      deleted: false,
    });

    store.removeFolder("empty");
    expect(store.getFolder("empty")).toBeUndefined();
  });

  it("restores from a snapshot without sharing record objects", async () => {
    const snapshot: SyncMetadata = {
      version: 1,
      files: {
        "note.md": {
          path: "note.md",
          sha: "abc",
          dirty: false,
          lastModified: 1,
          deleted: false,
        },
      },
      folders: {},
    };
    const store = new MetadataStore(async () => null, async () => {});

    store.restore(snapshot);
    store.update("note.md", { sha: "changed" }, 2);

    expect(snapshot.files["note.md"].sha).toBe("abc");
  });
});

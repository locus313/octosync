import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, gitBlobSha } from "../src/hash";

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function text(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

describe("hash helpers", () => {
  it("calculates Git-compatible blob SHAs", async () => {
    await expect(gitBlobSha(bytes(""))).resolves.toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    await expect(gitBlobSha(bytes("hello world\n"))).resolves.toBe(
      "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
    );
  });

  it("round-trips bytes through base64", () => {
    const original = bytes("hello\nOctosync\0");
    const encoded = bytesToBase64(original);

    expect(text(base64ToBytes(encoded))).toBe("hello\nOctosync\0");
  });

  it("decodes base64 with whitespace", () => {
    expect(text(base64ToBytes("aG Vs\nbG8="))).toBe("hello");
  });
});

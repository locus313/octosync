export async function gitBlobSha(bytes: ArrayBuffer): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const combined = new Uint8Array(prefix.byteLength + bytes.byteLength);
  combined.set(prefix, 0);
  combined.set(new Uint8Array(bytes), prefix.byteLength);

  const digest = await crypto.subtle.digest("SHA-1", combined);
  return toHex(digest);
}

export function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < view.length; index += chunkSize) {
    const chunk = view.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(content: string): ArrayBuffer {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

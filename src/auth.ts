import type { OctosyncSettings } from "./types";

export interface AuthProvider {
  getAuthorizationHeader(): string;
}

export class PersonalAccessTokenAuthProvider implements AuthProvider {
  constructor(private readonly settings: OctosyncSettings) {}

  getAuthorizationHeader(): string {
    if (!this.settings.token.trim()) {
      throw new Error("GitHub token is required.");
    }

    return `Bearer ${this.settings.token.trim()}`;
  }
}

export function createAuthProvider(settings: OctosyncSettings): AuthProvider {
  return new PersonalAccessTokenAuthProvider(settings);
}

import type { OctosyncSettings } from "./types";

const MAX_DEBUG_LOG_ENTRIES = 300;

export interface DebugLogEntry {
  timestamp: string;
  message: string;
  data?: unknown;
}

export type DebugLogSink = (message: string, data?: unknown) => void;

export class DebugLog {
  private entries: DebugLogEntry[] = [];

  constructor(
    private readonly settings: OctosyncSettings,
    private readonly saveEntries: (entries: DebugLogEntry[]) => Promise<void>,
  ) {}

  load(entries: unknown): void {
    this.entries = Array.isArray(entries)
      ? entries.filter(isDebugLogEntry).slice(-MAX_DEBUG_LOG_ENTRIES)
      : [];
  }

  getEntries(): DebugLogEntry[] {
    return [...this.entries];
  }

  format(): string {
    return this.entries
      .map((entry) => {
        const data = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
        return `[${entry.timestamp}] ${entry.message}${data}`;
      })
      .join("\n");
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.saveEntries(this.entries);
  }

  write(message: string, data?: unknown): void {
    if (!this.settings.debugLogging) {
      return;
    }

    this.entries.push({
      timestamp: new Date().toISOString(),
      message,
      data: sanitize(data),
    });
    this.entries = this.entries.slice(-MAX_DEBUG_LOG_ENTRIES);
    void this.saveEntries(this.entries);
  }
}

function isDebugLogEntry(value: unknown): value is DebugLogEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DebugLogEntry>;
  return typeof candidate.timestamp === "string" && typeof candidate.message === "string";
}

function sanitize(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      /authorization|token|secret|password/i.test(key) ? "[redacted]" : sanitize(nestedValue),
    ]),
  );
}

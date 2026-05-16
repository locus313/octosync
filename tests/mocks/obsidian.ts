export class TFile {
  constructor(readonly path: string) {}
}

export class TFolder {
  children: Array<TFile | TFolder> = [];

  constructor(readonly path: string) {}
}

export class Vault {}

export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }
}

type RequestUrl = (request: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}) => Promise<{
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
}>;

let requestUrlMock: RequestUrl | null = null;

export function setRequestUrlMock(mock: RequestUrl | null): void {
  requestUrlMock = mock;
}

export async function requestUrl(request: Parameters<RequestUrl>[0]): Promise<Awaited<ReturnType<RequestUrl>>> {
  if (!requestUrlMock) {
    throw new Error("requestUrl is not available in tests.");
  }

  return requestUrlMock(request);
}

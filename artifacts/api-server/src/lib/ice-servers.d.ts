import type { IceServer } from "@workspace/api-zod";

export interface IceCredentialRateLimitStore {
  consume(
    clientKey: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<number>;
}

export function createIceCredentialRateLimiter(options: {
  store: IceCredentialRateLimitStore;
  maxRequests?: number;
  windowMs?: number;
}): (clientIp?: string) => Promise<number>;

export function createPostgresIceCredentialRateLimitStore(options: {
  query: (
    statement: string,
    parameters: (string | number)[],
  ) => Promise<{
    rows: Array<{
      request_count: string | number;
      retry_after_seconds: string | number;
    }>;
  }>;
  onCleanupError?: (error: unknown) => void;
  now?: () => number;
}): IceCredentialRateLimitStore;

export function createIceServers(
  environment?: NodeJS.ProcessEnv,
  now?: number,
): IceServer[];

export function createCloudflareIceServers(
  environment?: NodeJS.ProcessEnv,
  fetchImpl?: typeof globalThis.fetch,
): Promise<IceServer[]>;

export function createMeteredIceServers(
  environment?: NodeJS.ProcessEnv,
  fetchImpl?: typeof globalThis.fetch,
): Promise<IceServer[]>;

export function createMeteredOpenRelayIceServers(
  environment?: NodeJS.ProcessEnv,
  now?: number,
): IceServer[];

export function createConfiguredIceServers(
  environment?: NodeJS.ProcessEnv,
  fetchImpl?: typeof globalThis.fetch,
): Promise<IceServer[]>;
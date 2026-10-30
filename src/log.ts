import { SdkHttpError } from '@modelcontextprotocol/client';

/**
 * stdout is the MCP wire. Anything written there that is not a framed JSON-RPC
 * message corrupts the stream and the host disconnects, so every human-readable
 * line — including fatal errors — goes to stderr.
 */
export const log = (...parts: readonly unknown[]): void => {
  process.stderr.write(`${parts.map((part) => String(part)).join(' ')}\n`);
};

/**
 * What a failure is called on stderr and in the error a host reads: a status or a cause, and never
 * an upstream body, which the SDK puts in `error.message`. A body is free text from another system,
 * and a proxy that echoes request headers would carry the credential out with it.
 */
export const describeFailure = (error: unknown): string => {
  if (error instanceof SdkHttpError) {
    return `HTTP ${error.status} ${error.statusText ?? ''}`.trimEnd();
  }

  // The message of a failed `JSON.parse` quotes the text it could not parse.
  if (error instanceof SyntaxError) {
    return 'the upstream sent a frame that is not JSON';
  }

  if (!(error instanceof Error)) {
    return String(error);
  }

  // `fetch` reports every network failure as "fetch failed" and keeps the reason in `cause`, whose
  // message is empty when a dual-stack connection fails on both addresses.
  const cause = error.cause as (Error & { code?: string }) | undefined;
  const reason = cause?.message || cause?.code;

  return reason === undefined ? error.message : `${error.message}: ${reason}`;
};

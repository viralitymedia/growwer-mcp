import { SdkHttpError } from '@modelcontextprotocol/client';

/**
 * stdout is the MCP wire. Anything written there that is not a framed JSON-RPC
 * message corrupts the stream and the host disconnects, so every human-readable
 * line — including fatal errors — goes to stderr.
 */
export const log = (...parts: readonly unknown[]): void => {
  process.stderr.write(`${parts.map((part) => String(part)).join(' ')}\n`);
};

/** A failure this bridge words itself. Its message is fixed text written here, so it is shown. */
export class BridgeFailure extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BridgeFailure';
  }
}

/** A class name or an error code: a fixed identifier, never text that could carry a value. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

const codeOf = (value: unknown): string | undefined => {
  const code = (value as { code?: unknown } | null | undefined)?.code;

  return typeof code === 'string' && IDENTIFIER.test(code) ? code : undefined;
};

/**
 * What a failure is called on stderr and in the error a host reads: a status, or the error's class
 * and code, and never a message. The SDK puts an upstream body in `error.message`, which is free
 * text from another system, and a proxy that echoes request headers would carry the credential out
 * with it. Other messages quote input too: undici's header and URL errors quote the value they
 * refused, which may be the credential or an endpoint carrying one.
 */
export const describeFailure = (error: unknown): string => {
  if (error instanceof BridgeFailure) {
    return error.message;
  }

  if (error instanceof SdkHttpError) {
    return `HTTP ${error.status} ${error.statusText ?? ''}`.trimEnd();
  }

  // The message of a failed `JSON.parse` quotes the text it could not parse.
  if (error instanceof SyntaxError) {
    return 'the upstream sent a frame that is not JSON';
  }

  if (!(error instanceof Error)) {
    return 'a failure that is not an Error';
  }

  // `fetch` reports every network failure as a TypeError, "fetch failed", and keeps the reason in
  // `cause`, whose code (ECONNREFUSED, ENOTFOUND, UND_ERR_SOCKET) is what tells failures apart. An
  // SDK error carries its own code instead.
  const name = IDENTIFIER.test(error.name) ? error.name : 'Error';
  const codes = [...new Set([codeOf(error), codeOf(error.cause)])].filter((code) => code !== undefined);

  return codes.length === 0 ? name : `${name} (${codes.join(', ')})`;
};

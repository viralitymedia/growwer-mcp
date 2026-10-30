import type { Readable, Writable } from 'node:stream';

import {
  INTERNAL_ERROR,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  isInitializeRequest,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { BUYER_KEYS_URL, SELLER_KEYS_URL, TOKEN_ENV_VAR } from './config.ts';
import { describeFailure, log } from './log.ts';
import { USER_AGENT } from './version.ts';

/**
 * Id used for the internal `initialize` replayed after a session is evicted
 * upstream. It never reaches the host, and the response carrying it is
 * swallowed, so it cannot collide with a host-issued id of its own making.
 */
const REPLAY_ID_PREFIX = 'growwer-mcp/reinitialize/';

const CREDENTIAL_REJECTED =
  `The Growwer API rejected the credential (HTTP 401). Create an API key at ${BUYER_KEYS_URL} ` +
  `or ${SELLER_KEYS_URL}, and set ${TOKEN_ENV_VAR}.`;

export interface BridgeOptions {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** Injectable for tests; defaults to the process streams. */
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  /** Called once when the bridge can no longer serve the host. */
  readonly onClose?: () => void;
}

export interface Bridge {
  close(): Promise<void>;
}

/**
 * 404 is the one status that means the session is gone. Growwer answers 400 to a request with no
 * session header at all, which a replay cannot help: a host that never sent `initialize` has
 * nothing to replay, and a host that did would only send the same malformed frame again.
 */
const isSessionGone = (error: unknown): boolean => error instanceof SdkHttpError && error.status === 404;

const isCredentialRejected = (error: unknown): boolean =>
  error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401);

/**
 * Splices a stdio transport onto a Streamable HTTP transport at the transport
 * layer: every frame crosses verbatim in both directions.
 *
 * Deliberately not built on `Client`/`Server`. `Protocol` answers `ping`,
 * `notifications/progress` and `notifications/cancelled` itself, `Server` owns
 * `initialize`, and the era codec rejects spec methods absent from the
 * negotiated revision before any fallback handler runs — so nothing routed
 * through those classes can be transparent. Splicing transports means this
 * bridge needs no knowledge of the method set, and keeps working when the
 * upstream server gains methods this package has never heard of.
 *
 * The splice owes the host one thing a transport does not give it: an answer to
 * every request. A host waits on a request's id, so a request that fails between
 * the two transports must end in a JSON-RPC error on that id, or the host hangs
 * until its own timeout. Notifications and responses have nobody waiting, so
 * their failures are only logged.
 */
export const startBridge = async (options: BridgeOptions): Promise<Bridge> => {
  const local = new StdioServerTransport(options.stdin, options.stdout);

  /**
   * The host's `initialize` frame, kept so the session can be rebuilt without
   * the host noticing. Streamable HTTP sessions are server-owned state: a
   * restarted or scaled-down upstream answers the next POST with 404, and
   * without a replay every later request fails for the life of the process.
   */
  let handshake: JSONRPCRequest | undefined;
  let negotiatedVersion: string | undefined;
  let replayCount = 0;
  let closing = false;

  /** The replay in progress. Parallel failures wait on it rather than each starting their own. */
  let reestablishing: Promise<void> | undefined;
  /** Set when a replay failed: the session is gone, so the next frame rebuilds it first. */
  let replayOwed = false;
  let onReplayAnswer: ((message: JSONRPCMessage) => void) | undefined;

  /**
   * Host requests with no answer yet, and the transport each was sent on, which
   * is undefined while one waits for a replay. An entry leaves as its response
   * crosses, so whatever is still here when a stream ends went unanswered.
   */
  const open = new Map<RequestId, StreamableHTTPClientTransport | undefined>();

  /** Upstream requests the host has not answered yet, all of them on the current session. */
  const awaitingHost = new Set<RequestId>();

  let remote = createRemote();

  function createRemote(): StreamableHTTPClientTransport {
    const transport = new StreamableHTTPClientTransport(options.url, {
      requestInit: { headers: { ...options.headers, 'User-Agent': USER_AGENT } },
    });

    transport.onmessage = (message) => {
      if (isReplayResponse(message)) {
        onReplayAnswer?.(message);

        return;
      }

      captureNegotiatedVersion(transport, message);

      if (isJSONRPCResponse(message) && message.id !== undefined) {
        open.delete(message.id);
      }

      if (isJSONRPCRequest(message)) {
        awaitingHost.add(message.id);
      }

      void local.send(message).catch((error: unknown) => {
        log(`growwer-mcp: could not write to the host: ${describeFailure(error)}`);
      });
    };

    transport.onerror = (error) => {
      log(`growwer-mcp: upstream error: ${describeFailure(error)}`);
    };

    transport.onclose = () => {
      void shutdown();
    };

    return transport;
  }

  function isReplayResponse(message: JSONRPCMessage): boolean {
    return 'id' in message && typeof message.id === 'string' && message.id.startsWith(REPLAY_ID_PREFIX);
  }

  /**
   * The host, not this bridge, negotiates the protocol revision. Streamable
   * HTTP requires every post-handshake request to echo the negotiated version
   * in `MCP-Protocol-Version`, and nothing else in a transport-only splice will
   * set it — so read it off the `initialize` result as it passes through.
   */
  function captureNegotiatedVersion(transport: StreamableHTTPClientTransport, message: JSONRPCMessage): void {
    if (handshake === undefined || !isJSONRPCResultResponse(message) || message.id !== handshake.id) {
      return;
    }

    const version = (message.result as { protocolVersion?: unknown }).protocolVersion;

    if (typeof version === 'string') {
      negotiatedVersion = version;
      transport.setProtocolVersion(version);
    }
  }

  /** Answers an open request with an error. The caller has checked it is still open. */
  async function fail(id: RequestId, reason: string): Promise<void> {
    open.delete(id);

    await local.send({ jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: reason } }).catch((error: unknown) => {
      log(`growwer-mcp: could not write to the host: ${describeFailure(error)}`);
    });
  }

  /**
   * Waits for the replayed `initialize` to be answered, not merely accepted: a
   * server may answer it over SSE, after `send` has returned, and an answer
   * carrying a JSON-RPC error means there is no session to retry on.
   */
  async function replayHandshake(next: StreamableHTTPClientTransport, frame: JSONRPCRequest): Promise<void> {
    replayCount += 1;

    const replay: JSONRPCRequest = { ...frame, id: `${REPLAY_ID_PREFIX}${replayCount}` };

    await new Promise<void>((resolve, reject) => {
      onReplayAnswer = (message) => {
        if (isJSONRPCResultResponse(message)) {
          resolve();
        } else {
          reject(new Error('the upstream refused the replayed handshake'));
        }
      };

      next
        .send(replay, {
          onRequestStreamEnd: () => reject(new Error('the upstream did not answer the replayed handshake')),
        })
        .catch(reject);
    }).finally(() => {
      onReplayAnswer = undefined;
    });

    if (negotiatedVersion !== undefined) {
      next.setProtocolVersion(negotiatedVersion);
    }

    await next.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /**
   * Takes a transport out of service. A request still open on it has lost its
   * stream with no way to learn the outcome, so it gets an error now; a replay
   * must not resend it, because it may already have run.
   */
  async function retire(transport: StreamableHTTPClientTransport): Promise<void> {
    delete transport.onmessage;
    delete transport.onerror;
    delete transport.onclose;

    const abandoned = [...open].filter(([, sentOn]) => sentOn === transport).map(([id]) => id);

    await Promise.all(
      abandoned.map((id) =>
        fail(id, 'The upstream session expired while this request was open. It may have run, so check before repeating it.')
      )
    );

    await transport.close().catch(() => undefined);
  }

  /**
   * Rebuilds the session on a new transport. The old one stays up until the new
   * one is ready, because closing it first would abort a parallel request's POST
   * before that request could read its own 404.
   */
  async function reestablish(frame: JSONRPCRequest): Promise<void> {
    const previous = remote;
    const next = createRemote();

    replayOwed = true;

    // These prompts belong to the session that is gone. A late answer to one must not reach the
    // next session, which never asked and would drop it.
    awaitingHost.clear();

    try {
      await next.start();
      await replayHandshake(next, frame);
      replayOwed = false;
      log('growwer-mcp: upstream session expired; reconnected transparently.');
    } finally {
      remote = next;
      await retire(previous);
    }
  }

  /**
   * Replays once however many sends failed. A send that used an older transport
   * has nothing to do: the session it found gone was replaced after it left.
   */
  function reestablishFrom(failed: StreamableHTTPClientTransport): Promise<void> {
    if (reestablishing === undefined && failed === remote && handshake !== undefined) {
      reestablishing = reestablish(handshake).finally(() => {
        reestablishing = undefined;
      });
    }

    return reestablishing ?? Promise.resolve();
  }

  /** Holds a frame back from a session that is being rebuilt, or that the last replay left owed. */
  async function awaitSession(): Promise<void> {
    await reestablishing?.catch(() => undefined);

    if (replayOwed && !closing) {
      await reestablishFrom(remote);
    }
  }

  async function failFrame(message: JSONRPCMessage, error: unknown): Promise<void> {
    if (isCredentialRejected(error)) {
      log(`growwer-mcp: ${CREDENTIAL_REJECTED}`);
      await Promise.all([...open.keys()].map((id) => fail(id, CREDENTIAL_REJECTED)));
      await shutdown();

      return;
    }

    const reason = describeFailure(error);

    log(`growwer-mcp: could not reach ${options.url.origin}${options.url.pathname}: ${reason}`);

    if (isJSONRPCRequest(message) && open.has(message.id)) {
      await fail(message.id, `The Growwer MCP server could not answer: ${reason}.`);
    }
  }

  async function forward(message: JSONRPCMessage, allowRetry = true): Promise<void> {
    const id = isJSONRPCRequest(message) ? message.id : undefined;

    // A response goes out in the tick `local.onmessage` matched it, on the session that asked. It must
    // not wait for a replay, whose new session never asked.
    if (!isJSONRPCResponse(message)) {
      try {
        await awaitSession();
      } catch (error: unknown) {
        await failFrame(message, error);

        return;
      }
    }

    if (closing || (id !== undefined && !open.has(id))) {
      return;
    }

    const used = remote;

    if (id !== undefined) {
      open.set(id, used);
    }

    try {
      await used.send(message, {
        onRequestStreamEnd: () => {
          // This also fires after a normal end, when the response has already cleared the entry.
          if (id !== undefined && open.get(id) === used) {
            void fail(id, 'The upstream stream ended without a result.');
          }
        },
      });
    } catch (error: unknown) {
      // A replay or a rejected credential got to this request first, or the host cancelled it.
      if (id !== undefined && open.get(id) !== used) {
        return;
      }

      const canReplay = allowRetry && isSessionGone(error) && handshake !== undefined && message !== handshake;

      if (!canReplay) {
        await failFrame(message, error);

        return;
      }

      if (id !== undefined) {
        open.set(id, undefined);
      }

      try {
        await reestablishFrom(used);
      } catch (replayError: unknown) {
        await failFrame(message, replayError);

        return;
      }

      // A 404 means the request never ran, so it is safe to send again. A response is not: the
      // prompt it answers died with the session, and the new session would drop it.
      if (id === undefined) {
        log('growwer-mcp: upstream session expired; a frame that was not a request was dropped.');

        return;
      }

      await forward(message, false);
    }
  }

  async function shutdown(): Promise<void> {
    if (closing) {
      return;
    }

    closing = true;

    delete remote.onclose;
    delete remote.onerror;
    delete local.onclose;

    await remote.terminateSession().catch(() => undefined);
    await Promise.allSettled([remote.close(), local.close()]);

    options.onClose?.();
  }

  local.onmessage = (message) => {
    if (isJSONRPCResponse(message)) {
      if (message.id === undefined || !awaitingHost.delete(message.id)) {
        log('growwer-mcp: dropped a host response that no upstream request is waiting for.');

        return;
      }
    }

    if (isJSONRPCRequest(message)) {
      open.set(message.id, undefined);

      if (isInitializeRequest(message)) {
        handshake = message;
        replayOwed = false;
      }
    }

    // A cancelled request is owed no answer, and the host would have to ignore one.
    if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
      open.delete((message.params as { requestId: RequestId }).requestId);
    }

    void forward(message);
  };

  local.onerror = (error) => {
    log(`growwer-mcp: stdio error: ${error.message}`);
  };

  local.onclose = () => {
    void shutdown();
  };

  await remote.start();
  await local.start();

  return { close: shutdown };
};

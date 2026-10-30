import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A pair of streams standing in for the host's stdin/stdout. */
export class StdioPair {
  public readonly toServer = new PassThrough();

  public readonly fromServer = new PassThrough();

  private buffer = '';

  private readonly queue: JsonRpcMessage[] = [];

  private readonly waiters: ((message: JsonRpcMessage) => void)[] = [];

  public constructor() {
    this.fromServer.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');

      let newline = this.buffer.indexOf('\n');

      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);

        if (line !== '') {
          const message = JSON.parse(line) as JsonRpcMessage;
          const waiter = this.waiters.shift();

          if (waiter === undefined) {
            this.queue.push(message);
          } else {
            waiter(message);
          }
        }

        newline = this.buffer.indexOf('\n');
      }
    });
  }

  public send(message: JsonRpcMessage): void {
    this.toServer.write(`${JSON.stringify(message)}\n`);
  }

  public async next(timeoutMs = 5_000): Promise<JsonRpcMessage> {
    const queued = this.queue.shift();

    if (queued !== undefined) {
      return queued;
    }

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter = (message: JsonRpcMessage): void => {
        clearTimeout(timer);
        resolve(message);
      };

      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('timed out waiting for a message'));
      }, timeoutMs);

      this.waiters.push(waiter);
    });
  }

  /** Fails if the bridge writes anything to the host within the window. */
  public async assertSilent(windowMs = 150): Promise<void> {
    const message = await this.next(windowMs).catch(() => undefined);

    if (message !== undefined) {
      throw new Error(`expected silence, got ${JSON.stringify(message)}`);
    }
  }
}

/** An SSE answer to a POST, written frame by frame so a test controls the timing. */
export interface SseStream {
  /** Writes a JSON-RPC frame as Growwer's server does: `event: message`, optionally with an id. */
  send(message: JsonRpcMessage, eventId?: string): void;
  /** Writes an event id with no data, which a resumable server opens a stream with. */
  priming(eventId: string): void;
  /** Writes bytes as they are, for a frame the server should never have sent. */
  raw(text: string): void;
  /** Writes an SSE comment, as a server keeping a long wait alive does. */
  comment(text: string): void;
  end(): void;
  /** Drops the connection mid-stream, as a crash or a proxy does. */
  drop(): void;
}

export interface Exchange {
  readonly message: JsonRpcMessage;
  readonly authorization?: string;
  reply(status: number, body?: string, contentType?: string): void;
  /** Opens an SSE answer, which for an `initialize` starts a session when told to. */
  sse(options?: { readonly startSession?: boolean }): SseStream;
  /** Drops the connection with no answer at all. */
  drop(): void;
}

/** Answers a frame, returning true, or returns false to leave it to the upstream's own rules. */
export type Script = (exchange: Exchange) => boolean | Promise<boolean>;

export interface FakeUpstreamOptions {
  /** Tools returned by `tools/list`. */
  readonly tools?: readonly { name: string; description: string }[];
  /** Prompts returned by `prompts/list`. */
  readonly prompts?: readonly { name: string; title: string }[];
  /** Status returned instead of a result, once, on the nth request (1-based). */
  readonly failOnRequest?: { readonly index: number; readonly status: number };
  /** Runs first on every frame, before the session rules. */
  readonly script?: Script;
  /** False for an upstream with no session rules, which answers a host that never initialized. */
  readonly requireSession?: boolean;
}

export interface RecordedRequest {
  method: string;
  id?: string | number;
  message: JsonRpcMessage;
  authorization?: string;
  protocolVersion?: string;
  sessionId?: string;
}

export interface FakeUpstream {
  readonly url: URL;
  readonly requests: RecordedRequest[];
  readonly sessions: string[];
  /** Forgets every session, as a restart does: their next frame gets a 404. */
  evict(): void;
  waitFor(match: (request: RecordedRequest) => boolean, timeoutMs?: number): Promise<RecordedRequest>;
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
};

const openSse = (response: ServerResponse, sessionId?: string): SseStream => {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
  });
  response.flushHeaders();

  return {
    send: (message, eventId) => {
      response.write(`${eventId === undefined ? '' : `id: ${eventId}\n`}event: message\ndata: ${JSON.stringify(message)}\n\n`);
    },
    priming: (eventId) => {
      response.write(`id: ${eventId}\ndata: \n\n`);
    },
    raw: (text) => {
      response.write(text);
    },
    comment: (text) => {
      response.write(`: ${text}\n\n`);
    },
    end: () => {
      response.end();
    },
    drop: () => {
      response.socket?.destroy();
    },
  };
};

/** A minimal Streamable HTTP MCP server, enough to exercise the bridge. */
export const startFakeUpstream = async (options: FakeUpstreamOptions = {}): Promise<FakeUpstream> => {
  const tools = options.tools ?? [{ name: 'list_projects', description: 'List projects.' }];
  const prompts = options.prompts ?? [{ name: 'find_media', title: 'Find media' }];
  const requests: RecordedRequest[] = [];
  const sessions: string[] = [];
  const live = new Set<string>();
  const watchers: ((request: RecordedRequest) => void)[] = [];

  let requestCount = 0;

  const mintSession = (): string => {
    const minted = `session-${sessions.length + 1}`;

    sessions.push(minted);
    live.add(minted);

    return minted;
  };

  const answer = (response: ServerResponse, id: string | number, result: Record<string, unknown>): void => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();

        return;
      }

      const body = await readBody(request);
      const message = JSON.parse(body) as JsonRpcMessage;
      const sessionId = request.headers['mcp-session-id'];

      const recorded: RecordedRequest = {
        method: message.method ?? '(response)',
        message,
        ...(message.id === undefined ? {} : { id: message.id }),
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        ...(typeof request.headers['mcp-protocol-version'] === 'string'
          ? { protocolVersion: request.headers['mcp-protocol-version'] }
          : {}),
        ...(typeof sessionId === 'string' ? { sessionId } : {}),
      };

      requests.push(recorded);
      watchers.forEach((watcher) => watcher(recorded));

      const exchange: Exchange = {
        message,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        reply: (status, text = '', contentType = 'application/json') => {
          response.writeHead(status, { 'content-type': contentType }).end(text);
        },
        sse: (sseOptions) => openSse(response, sseOptions?.startSession === true ? mintSession() : undefined),
        drop: () => {
          response.socket?.destroy();
        },
      };

      if ((await options.script?.(exchange)) === true) {
        return;
      }

      if (options.requireSession !== false && message.method !== 'initialize') {
        if (typeof sessionId !== 'string') {
          exchange.reply(400, JSON.stringify({ error: 'Mcp-Session-Id header is required' }));

          return;
        }

        if (!live.has(sessionId)) {
          exchange.reply(404, JSON.stringify({ error: 'session not found' }));

          return;
        }
      }

      // A frame with no method is a host's response and one with no id a notification: neither
      // holds a request, so a Streamable HTTP server has nothing to answer but its receipt.
      if (message.method === undefined || message.id === undefined) {
        response.writeHead(202).end();

        return;
      }

      requestCount += 1;

      if (options.failOnRequest !== undefined && options.failOnRequest.index === requestCount) {
        response
          .writeHead(options.failOnRequest.status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'session not found' }));

        return;
      }

      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': mintSession() }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
              serverInfo: { name: 'fake-growwer', version: '0.0.0' },
            },
          })
        );

        return;
      }

      if (message.method === 'prompts/list') {
        answer(response, message.id, { prompts });

        return;
      }

      if (message.method === 'prompts/get') {
        answer(response, message.id, {
          messages: [{ role: 'user', content: { type: 'text', text: `the ${String(message.params?.name)} prompt` } }],
        });

        return;
      }

      if (message.method === 'tools/list') {
        answer(response, message.id, { tools: tools.map((tool) => ({ ...tool, inputSchema: { type: 'object' } })) });

        return;
      }

      answer(response, message.id, { content: [{ type: 'text', text: 'ok' }] });
    })();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;

  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    requests,
    sessions,
    evict: () => {
      live.clear();
    },
    waitFor: async (match, timeoutMs = 5_000) => {
      const seen = requests.find(match);

      if (seen !== undefined) {
        return seen;
      }

      return new Promise<RecordedRequest>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for an upstream frame')), timeoutMs);

        watchers.push((request) => {
          if (match(request)) {
            clearTimeout(timer);
            resolve(request);
          }
        });
      });
    },
    close: async () => {
      if (!server.listening) {
        return;
      }

      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
};

import type { Readable, Writable } from 'node:stream';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  GetPromptResult,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { CATALOG, promptArgumentsSchema } from './catalog.ts';
import { BUYER_KEYS_URL, DEFAULT_MCP_URL, SELLER_KEYS_URL, TOKEN_ENV_VAR } from './config.ts';
import { describeFailure } from './log.ts';
import { PACKAGE_VERSION } from './version.ts';

export const SETUP_TOOL_NAME = 'growwer_setup';

/**
 * Tools the hosted server answers without a credential, on its public endpoint: they read published
 * material only (the Growwer guide). The keyless bridge forwards calls to them instead of refusing.
 */
export const PUBLIC_TOOLS: readonly string[] = ['growwer_get_guide'];

/** The hosted server's anonymous endpoint, on the same host as the configured one. */
export const publicEndpoint = (url: URL): URL => new URL('/public/v1/mcp', url);

const withPublicClient = async <T>(url: URL, read: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ name: 'growwer-mcp-bridge', version: PACKAGE_VERSION });

  try {
    await client.connect(new StreamableHTTPClientTransport(publicEndpoint(url)));

    return await read(client);
  } finally {
    await client.close().catch(() => undefined);
  }
};

const unreachable = (subject: string, url: URL, error: unknown): string =>
  `${subject} could not be reached at ${publicEndpoint(url).href}: ${describeFailure(error)}`;

const callPublicTool = async (url: URL, name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
  try {
    return await withPublicClient(url, async (client) => {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    });
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: unreachable('The public Growwer guide', url, error) }],
      isError: true,
    };
  }
};

/**
 * Prompts are static text with no account data, so the anonymous endpoint serves them as `/mcp`
 * does. A failure throws: a prompt has no `isError`, and text returned here would be read as the
 * prompt itself.
 */
const getPublicPrompt = async (url: URL, name: string, args: Record<string, string>): Promise<GetPromptResult> => {
  try {
    return await withPublicClient(url, (client) => client.getPrompt({ name, arguments: args }));
  } catch (error) {
    throw new Error(unreachable(`The public Growwer prompt "${name}"`, url, error));
  }
};

const setupText = (url: URL): string =>
  [
    'The Growwer MCP bridge is running without an API key, so no Growwer account is reachable yet.',
    '',
    'To finish setup:',
    `  1. Sign in and open your API keys page: ${BUYER_KEYS_URL}, or ${SELLER_KEYS_URL} if you sell.`,
    '  2. Create a key, read and write if the assistant should change anything. It is shown once and starts with "gw_sk_".',
    `  3. Restart this MCP server with ${TOKEN_ENV_VAR}=gw_sk_… in its environment.`,
    '',
    `Upstream endpoint: ${url.href}`,
    '',
    'Clients that speak remote MCP (Claude, ChatGPT, Claude Code, Cursor, Codex, VS Code,',
    `Gemini CLI) do not need this bridge at all: point them straight at ${DEFAULT_MCP_URL}`,
    'and sign in with OAuth.',
  ].join('\n');

const credentialRequired = (name: string, url: URL): string =>
  `"${name}" needs a Growwer API key, and this bridge has none.\n\n${setupText(url)}`;

/**
 * Accepts whatever it is given, because nothing here is ever executed with it.
 *
 * The default validator would reject a call with missing or malformed arguments before the handler
 * runs, and answer with a schema complaint. That is the right answer on the hosted server and the
 * wrong one here: the only thing this server can tell a caller is that a credential is missing, and
 * making them guess their way to it — argument by argument — buries the one useful message.
 */
const acceptAnyArguments: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/**
 * The server this package runs when no credential is configured.
 *
 * It exists so the package is introspectable without a secret: MCP registries, directory scanners
 * and `npx` tyre-kickers can start it, read `tools/list` and `prompts/list`, and see exactly what
 * a credentialed run offers. It advertises the real catalogue rather than only `growwer_setup`,
 * because a server whose entire surface is one setup tool is indistinguishable from a server with
 * nothing to offer — which is how it gets indexed.
 *
 * Advertising is not pretending: every catalogue tool answers a call with the setup instructions
 * and `isError`, so a model that tries one is told precisely what is missing instead of being
 * handed an empty result. What the catalogue cannot do is invent data, and it does not try to.
 */
export const createSetupServer = (url: URL): McpServer => {
  const server = new McpServer(
    { name: 'growwer-mcp-setup', title: 'Growwer (setup required)', version: PACKAGE_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions:
        `This Growwer MCP bridge has no API key configured, so every tool below reports what is ` +
        `missing rather than returning data, except "${PUBLIC_TOOLS.join('", "')}", which answers questions ` +
        `about Growwer itself from its public guide. Call "${SETUP_TOOL_NAME}" for setup instructions.`,
    }
  );

  server.registerTool(
    SETUP_TOOL_NAME,
    {
      title: 'Growwer setup instructions',
      description:
        'Explain how to finish connecting this bridge to Growwer. The bridge has no API key, so no project, order, wallet or seller data can be read until one is configured.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => ({ content: [{ type: 'text' as const, text: setupText(url) }] })
  );

  for (const tool of CATALOG.tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        inputSchema: fromJsonSchema(tool.inputSchema, acceptAnyArguments),
      },
      PUBLIC_TOOLS.includes(tool.name)
        ? (args: unknown) => callPublicTool(url, tool.name, (args ?? {}) as Record<string, unknown>)
        : () => ({ content: [{ type: 'text' as const, text: credentialRequired(tool.name, url) }], isError: true })
    );
  }

  for (const prompt of CATALOG.prompts) {
    server.registerPrompt(
      prompt.name,
      {
        ...(prompt.title === undefined ? {} : { title: prompt.title }),
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
        argsSchema: fromJsonSchema<Record<string, string>>(promptArgumentsSchema(prompt), acceptAnyArguments),
      },
      (args: Record<string, string>) => getPublicPrompt(url, prompt.name, args ?? {})
    );
  }

  return server;
};

export const startSetupServer = async (
  url: URL,
  stdin?: Readable,
  stdout?: Writable
): Promise<{ close: () => Promise<void> }> => {
  const server = createSetupServer(url);

  await server.connect(new StdioServerTransport(stdin, stdout));

  return { close: () => server.close() };
};

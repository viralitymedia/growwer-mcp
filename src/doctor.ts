import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';

import {
  BUYER_KEYS_URL,
  PUBLIC_PREFIX_LENGTH,
  SELLER_KEYS_URL,
  TOKEN_ENV_VAR,
  TOKEN_FORMAT,
  type Config,
} from './config.ts';
import { describeFailure } from './log.ts';
import { PACKAGE_VERSION, USER_AGENT } from './version.ts';

const line = (label: string, value: string): string => `${label.padEnd(18)}${value}`;

/**
 * The marker and the prefix Growwer looks a key up by, which are public. Anything else is not known
 * to be: a credential in another format may be a secret from another service, pasted here by mistake.
 */
const publicPart = (token: string): string =>
  TOKEN_FORMAT.test(token)
    ? `${token.slice(0, PUBLIC_PREFIX_LENGTH)}…`
    : 'set, but not a Growwer API key, so none of it is shown';

/**
 * A one-shot connectivity and credential check.
 *
 * `doctor` writes to stdout on purpose: it is a CLI command, not an MCP
 * session, so nothing is listening for framed messages on that stream.
 */
export const runDoctor = async (config: Config, write: (text: string) => void): Promise<number> => {
  write(`growwer-mcp ${PACKAGE_VERSION}`);
  write(line('Endpoint', config.url.href));
  write(line('Credential', config.token === undefined ? `missing (set ${TOKEN_ENV_VAR})` : publicPart(config.token)));

  if (config.token === undefined) {
    write('');
    write('No credential configured, so nothing was contacted.');
    write(`Create an API key at ${BUYER_KEYS_URL} or ${SELLER_KEYS_URL}, then re-run "growwer-mcp doctor".`);

    return 1;
  }

  const transport = new StreamableHTTPClientTransport(config.url, {
    requestInit: { headers: { ...config.headers, 'User-Agent': USER_AGENT } },
  });

  const client = new Client({ name: 'growwer-mcp-doctor', version: PACKAGE_VERSION });

  try {
    await client.connect(transport);

    const server = client.getServerVersion();
    const capabilities = client.getServerCapabilities() ?? {};

    write(line('Server', server === undefined ? 'unknown' : `${server.name} ${server.version}`));
    write(line('Protocol', transport.protocolVersion ?? 'not reported'));
    write(line('Capabilities', Object.keys(capabilities).sort().join(', ') || 'none'));

    if (capabilities.tools !== undefined) {
      const { tools } = await client.listTools();
      write(line('Tools', String(tools.length)));

      for (const tool of tools) {
        write(`  - ${tool.name}${tool.title === undefined ? '' : ` — ${tool.title}`}`);
      }
    }

    if (capabilities.prompts !== undefined) {
      const { prompts } = await client.listPrompts();
      write(line('Prompts', String(prompts.length)));

      for (const prompt of prompts) {
        write(`  - ${prompt.name}${prompt.title === undefined ? '' : ` — ${prompt.title}`}`);
      }
    }

    write('');
    write('OK — the credential works and the server answered.');

    return 0;
  } catch (error: unknown) {
    write('');

    if (error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401)) {
      write('FAILED — the Growwer API rejected the credential (HTTP 401).');
      write('The key may be revoked, or from a different environment.');
      write(`Create a new one at ${BUYER_KEYS_URL} or ${SELLER_KEYS_URL}.`);

      return 1;
    }

    write(`FAILED — ${describeFailure(error)}`);

    return 1;
  } finally {
    await client.close().catch(() => undefined);
  }
};

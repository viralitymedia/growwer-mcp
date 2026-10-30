#!/usr/bin/env node
import {
  BUYER_KEYS_URL,
  ConfigError,
  DEFAULT_MCP_URL,
  SELLER_KEYS_URL,
  TOKEN_ENV_VAR,
  URL_ENV_VAR,
  parseArgs,
} from './config.ts';
import { startBridge } from './bridge.ts';
import { log } from './log.ts';
import { runDoctor } from './doctor.ts';
import { startSetupServer } from './setup-server.ts';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.ts';

const HELP = `growwer-mcp ${PACKAGE_VERSION}

Bridges a stdio MCP client to the hosted Growwer MCP server.
Clients that speak remote MCP should connect to ${DEFAULT_MCP_URL} directly
instead — this bridge exists for hosts that can only spawn a stdio process.

Usage
  growwer-mcp [serve] [--url <url>] [--header "Name: value"]
  growwer-mcp doctor
  growwer-mcp --help | --version

Commands
  serve     Run the bridge on stdio (default).
  doctor    Check the endpoint and key, then list the server's tools.

Options
  --url <url>              Upstream MCP endpoint. Default ${DEFAULT_MCP_URL}
  --header "Name: value"   Extra HTTP header. Repeatable.
  -h, --help               Show this help.
  -v, --version            Show the version.

Environment
  ${TOKEN_ENV_VAR}    Growwer API key (gw_sk_…). Required to reach an account.
  ${URL_ENV_VAR}    Upstream MCP endpoint, overridden by --url.

Get a key at ${BUYER_KEYS_URL}
or ${SELLER_KEYS_URL}
`;

const main = async (): Promise<number> => {
  const config = parseArgs(process.argv.slice(2), process.env);

  if (config.command === 'help') {
    process.stdout.write(HELP);

    return 0;
  }

  if (config.command === 'version') {
    process.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);

    return 0;
  }

  for (const warning of config.warnings) {
    log(`growwer-mcp: ${warning}`);
  }

  if (config.command === 'doctor') {
    return runDoctor(config, (text) => process.stdout.write(`${text}\n`));
  }

  if (config.token === undefined) {
    log(`growwer-mcp: no ${TOKEN_ENV_VAR} set — serving setup instructions only.`);

    const server = await startSetupServer(config.url);

    process.once('SIGINT', () => void server.close());
    process.once('SIGTERM', () => void server.close());

    return 0;
  }

  const bridge = await startBridge({
    url: config.url,
    headers: config.headers,
    onClose: () => process.exit(0),
  });

  process.once('SIGINT', () => void bridge.close());
  process.once('SIGTERM', () => void bridge.close());

  return 0;
};

try {
  process.exitCode = await main();
} catch (error: unknown) {
  if (error instanceof ConfigError) {
    log(`growwer-mcp: ${error.message}`);
    process.exitCode = 2;
  } else {
    log(`growwer-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

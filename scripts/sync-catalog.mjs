#!/usr/bin/env node
/**
 * Refreshes `catalog.json` from the hosted server's anonymous catalogue endpoint.
 *
 * The uncredentialed bridge advertises that catalogue verbatim, so a stale copy is a lie told to
 * every registry that scans this package — and nothing in the package itself can notice, because
 * the truth lives in another repository. `--check` is the same read with an exit code instead of a
 * write, for CI to run on a schedule.
 *
 * No credential is involved: the endpoint serves discovery only.
 *
 *   node scripts/sync-catalog.mjs [--url <endpoint>] [--check]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { serializeCatalog } from './catalog-format.mjs';

const CATALOG_PATH = fileURLToPath(new URL('../catalog.json', import.meta.url));

// The hosted endpoint. `--url` reads another one, such as a local stack before a deploy, but the file
// keeps this: it says what the catalogue must match, and the drift check reads it from here.
const DEFAULT_SOURCE = 'https://tool.growwer.com/public/v1/mcp';

const parseArgs = (argv) => {
  let check = false;
  let url;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--check') {
      check = true;
      continue;
    }

    if (argument === '--url') {
      index += 1;
      url = argv[index];

      if (url === undefined) {
        throw new Error('--url expects a value.');
      }

      continue;
    }

    throw new Error(`Unknown argument "${argument}".`);
  }

  return { check, url };
};

const fetchCatalog = async (endpoint) => {
  const client = new Client({ name: 'growwer-mcp-catalog-sync', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();

    return { tools, prompts };
  } finally {
    await client.close().catch(() => undefined);
  }
};

const main = async () => {
  const { check, url } = parseArgs(process.argv.slice(2));
  const committed = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, 'utf8') : undefined;
  const source = committed === undefined ? DEFAULT_SOURCE : JSON.parse(committed).source;
  const endpoint = url ?? source;

  const live = serializeCatalog({ source, ...(await fetchCatalog(endpoint)) });

  if (live === committed) {
    process.stdout.write(`catalog.json is up to date with ${endpoint}\n`);

    return 0;
  }

  if (check) {
    process.stderr.write(
      `catalog.json no longer matches ${endpoint}.\n` +
        'Run "npm run sync:catalog", review the diff, and commit it before the next release.\n'
    );

    return 1;
  }

  writeFileSync(CATALOG_PATH, live);
  process.stdout.write(`catalog.json updated from ${endpoint}\n`);

  return 0;
};

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`sync-catalog: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

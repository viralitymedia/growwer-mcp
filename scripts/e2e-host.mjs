#!/usr/bin/env node
/**
 * Drives the built bridge the way a stdio host does, against a running Growwer stack: it spawns
 * `dist/cli.js`, lists the tools, runs a read and a plain write, then a guarded write as a host
 * without form elicitation, as one that declines, and as one that accepts. The unit suite proves
 * the bridge against a fake upstream; only this proves it against the server the fake imitates.
 *
 * It deletes projects, so point it at a development stack, never at production. The key's account
 * must own a disposable project named "bridge-e2e" for each protocol below, and the run deletes
 * them: creating one through the API reaches services a development stack keeps stubbed, so they
 * are seeded beforehand instead. The plain write is a saved filter, created and then deleted. The
 * key comes from GROWWER_API_KEY and is never printed. Exits non-zero on the first failure.
 *
 *   npm run build
 *   GROWWER_API_KEY=gw_sk_… node scripts/e2e-host.mjs --url http://localhost:<port>/mcp
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const EXPECTED_TOOLS = 69;
const DISPOSABLE_PROJECT = 'bridge-e2e';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// 2025-11-25 asks through `elicitation/create` during the call, 2026-07-28 through an
// `input_required` result and a retry. A guarded write has to cross on both.
const PROTOCOLS = [
  { label: '2025-11-25', versionNegotiation: { mode: 'legacy' } },
  { label: '2026-07-28', versionNegotiation: { mode: { pin: '2026-07-28' } } },
];

const { values } = parseArgs({ options: { url: { type: 'string' } } });
const key = process.env.GROWWER_API_KEY;

if (values.url === undefined || !key) {
  process.stderr.write('Usage: GROWWER_API_KEY=gw_sk_… node scripts/e2e-host.mjs --url <stack>/mcp\n');
  process.exit(2);
}

const step = (message) => process.stdout.write(`  ok  ${message}\n`);

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const text = (result) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

const withHost = async ({ versionNegotiation, onForm }, run) => {
  const client = new Client(
    { name: 'growwer-e2e-host', version: '1.0.0' },
    { capabilities: onForm === undefined ? {} : { elicitation: { form: {} } }, versionNegotiation }
  );

  if (onForm !== undefined) {
    client.setRequestHandler('elicitation/create', onForm);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--url', values.url],
    env: { GROWWER_API_KEY: key, PATH: process.env.PATH ?? '' },
    stderr: 'inherit',
  });

  try {
    await client.connect(transport);

    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
};

const listTools = async (client) => {
  const tools = [];
  let cursor;

  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });

    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return tools;
};

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

const write = (client, name, args) => call(client, name, { requestId: randomUUID(), ...args });

const expectSuccess = (result, what) => {
  assert(result.isError !== true, `${what} failed: ${text(result)}`);

  return result;
};

const expectRefusal = (result, code, what) => {
  assert(result.isError === true && text(result).includes(code), `${what} should answer ${code}: ${text(result)}`);
};

const json = (result, what) => JSON.parse(text(expectSuccess(result, what)));

const disposableProject = async (client) => {
  const projects = json(await call(client, 'growwer_list_projects'), 'Listing the projects');
  const ids = projects.items.filter((project) => project.name === DISPOSABLE_PROJECT).map((project) => project.id);

  assert(ids.length > 0, `The account owns no project named "${DISPOSABLE_PROJECT}"; seed one per protocol`);

  return ids[0];
};

const plainWrite = async (client, project) => {
  const filter = json(
    await write(client, 'growwer_create_saved_filter', {
      id: project,
      name: 'bridge e2e',
      filters: { language: ['es'] },
    }),
    'The plain write'
  );

  expectSuccess(await write(client, 'growwer_delete_saved_filter', { id: project, filterId: filter.id }), 'Its cleanup');
};

const confirmDelete = async (client, id, onFormSeen) => {
  const result = await write(client, 'growwer_delete_project', { id });

  assert(onFormSeen(), 'The host was never shown the form');

  return result;
};

const runProtocol = async ({ label, versionNegotiation }) => {
  process.stdout.write(`Protocol ${label}\n`);

  const id = await withHost({ versionNegotiation }, async (client) => {
    const tools = await listTools(client);

    assert(tools.length === EXPECTED_TOOLS, `Listed ${tools.length} tools, not ${EXPECTED_TOOLS}`);
    step(`tools/list shows ${tools.length} tools`);

    expectSuccess(await call(client, 'growwer_get_me'), 'The read');
    step('a read answered');

    const project = await disposableProject(client);

    await plainWrite(client, project);
    step('a plain write created a saved filter, and deleted it');

    expectRefusal(
      await write(client, 'growwer_delete_project', { id: project }),
      'elicitation_unsupported',
      'A guarded write without form elicitation'
    );
    expectSuccess(await call(client, 'growwer_get_project', { id: project }), 'The project after that refusal');
    step('a host without form elicitation gets elicitation_unsupported, and nothing changed');

    return project;
  });

  let forms = 0;

  await withHost(
    {
      versionNegotiation,
      onForm: () => {
        forms += 1;

        return { action: 'decline' };
      },
    },
    async (client) => {
      expectRefusal(await confirmDelete(client, id, () => forms > 0), 'confirmation_declined', 'A declined write');
      expectSuccess(await call(client, 'growwer_get_project', { id }), 'The project after the decline');
      step('Decline gives confirmation_declined, and the project is still there');
    }
  );

  forms = 0;

  await withHost(
    {
      versionNegotiation,
      onForm: () => {
        forms += 1;

        return { action: 'accept', content: { confirm: true } };
      },
    },
    async (client) => {
      expectSuccess(await confirmDelete(client, id, () => forms > 0), 'An accepted write');

      const after = await call(client, 'growwer_get_project', { id });

      assert(after.isError === true, `The project survived the delete: ${text(after)}`);
      step('Accept runs the write, and the project is gone');
    }
  );
};

try {
  for (const protocol of PROTOCOLS) {
    await runProtocol(protocol);
  }

  process.stdout.write('All passed.\n');
} catch (error) {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

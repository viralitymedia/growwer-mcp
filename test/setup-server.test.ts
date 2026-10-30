import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { CATALOG } from '../src/catalog.ts';
import { PUBLIC_TOOLS, SETUP_TOOL_NAME, publicEndpoint, startSetupServer } from '../src/setup-server.ts';
import { StdioPair, startFakeUpstream, type JsonRpcMessage } from './helpers.ts';

const ENDPOINT = new URL('https://tool.growwer.com/mcp');

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface ListedPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; required?: boolean }[];
}

/** Brings up the keyless server and completes the handshake. */
const handshake = async (url: URL = ENDPOINT): Promise<{ stdio: StdioPair; capabilities: Record<string, unknown> }> => {
  const stdio = new StdioPair();
  const server = await startSetupServer(url, stdio.toServer, stdio.fromServer);

  after(async () => {
    await server.close();
  });

  stdio.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-host', version: '1.0.0' },
    },
  });

  const initialized = await stdio.next();

  stdio.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    stdio,
    capabilities: (initialized.result as { capabilities: Record<string, unknown> }).capabilities,
  };
};

const request = async (stdio: StdioPair, message: JsonRpcMessage): Promise<JsonRpcMessage> => {
  stdio.send(message);

  return stdio.next();
};

describe('the keyless setup server', () => {
  it('advertises the hosted server’s full catalogue, not just a setup tool', async () => {
    const { stdio, capabilities } = await handshake();

    assert.deepEqual(Object.keys(capabilities).sort(), ['prompts', 'tools']);

    const listed = await request(stdio, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (listed.result as { tools: ListedTool[] }).tools;

    // A scanner that starts this package without a credential must see what a credentialed run
    // offers; a lone setup tool reads as a server with nothing to offer.
    assert.equal(tools.length, CATALOG.tools.length + 1);

    const names = tools.map((tool) => tool.name).sort();
    const expected = [SETUP_TOOL_NAME, ...CATALOG.tools.map((tool) => tool.name)].sort();

    assert.deepEqual(names, expected);
  });

  it('advertises each tool exactly as the hosted server describes it', async () => {
    const { stdio } = await handshake();

    const listed = await request(stdio, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = new Map((listed.result as { tools: ListedTool[] }).tools.map((tool) => [tool.name, tool]));

    for (const expected of CATALOG.tools) {
      const advertised = tools.get(expected.name);

      assert.ok(advertised !== undefined, `${expected.name} is missing from tools/list`);
      assert.equal(advertised.title, expected.title);
      assert.equal(advertised.description, expected.description);
      assert.deepEqual(advertised.inputSchema, expected.inputSchema);
      assert.deepEqual(advertised.annotations, expected.annotations);
    }
  });

  it('answers a catalogue tool call with the setup instructions rather than an empty result', async () => {
    const { stdio } = await handshake();
    const [first] = CATALOG.tools;

    assert.ok(first !== undefined);

    const called = await request(stdio, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: first.name, arguments: {} },
    });

    const result = called.result as { content: { type: string; text: string }[]; isError?: boolean };

    assert.equal(result.isError, true, 'a model must not read the refusal as a successful empty answer');
    assert.match(result.content[0]?.text ?? '', new RegExp(first.name));
    assert.match(result.content[0]?.text ?? '', /GROWWER_API_KEY/);
    assert.match(result.content[0]?.text ?? '', /gw_sk_/);
  });

  it('still serves the setup tool itself successfully', async () => {
    const { stdio } = await handshake();

    const called = await request(stdio, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: SETUP_TOOL_NAME, arguments: {} },
    });

    const result = called.result as { content: { type: string; text: string }[]; isError?: boolean };

    assert.notEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /GROWWER_API_KEY/);
    assert.match(result.content[0]?.text ?? '', /gw_sk_/);
  });

  it('advertises the prompt catalogue with its arguments', async () => {
    const { stdio } = await handshake();

    const listed = await request(stdio, { jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    const prompts = new Map((listed.result as { prompts: ListedPrompt[] }).prompts.map((p) => [p.name, p]));

    assert.equal(prompts.size, CATALOG.prompts.length);

    for (const expected of CATALOG.prompts) {
      const advertised = prompts.get(expected.name);

      assert.ok(advertised !== undefined, `${expected.name} is missing from prompts/list`);
      assert.equal(advertised.title, expected.title);
      assert.equal(advertised.description, expected.description);
      assert.deepEqual(
        (advertised.arguments ?? []).map((argument) => argument.name).sort(),
        (expected.arguments ?? []).map((argument) => argument.name).sort()
      );
    }
  });

});

describe('the shipped catalogue', () => {
  it('carries the hosted server’s whole surface', () => {
    // A sync that silently produced an empty or truncated catalogue would reintroduce exactly the
    // "server with no tools" reading this package exists to avoid.
    assert.ok(CATALOG.tools.length >= 69, `only ${CATALOG.tools.length} tools in catalog.json`);
    assert.ok(CATALOG.prompts.length >= 6, `only ${CATALOG.prompts.length} prompts in catalog.json`);
    assert.equal(CATALOG.source, 'https://tool.growwer.com/public/v1/mcp');
  });

  it('describes every tool well enough to be worth advertising', () => {
    for (const tool of CATALOG.tools) {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not a snake_case tool name`);
      assert.ok((tool.description ?? '').length >= 40, `${tool.name} has no usable description`);
      assert.ok(tool.title !== undefined && tool.title !== '', `${tool.name} has no title`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no object input schema`);
      // Directories grade, and ChatGPT review requires, an explicit value for every hint rather
      // than the protocol defaults, which assume a destructive, open-world tool.
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} does not declare ${hint}`);
      }
      if (tool.annotations?.readOnlyHint === true) {
        assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is read-only yet destructive`);
      }
    }
  });
});

describe('the public guide without a credential', () => {
  it('points at the anonymous endpoint on the configured host', () => {
    assert.equal(publicEndpoint(new URL('https://tool.growwer.com/mcp')).href, 'https://tool.growwer.com/public/v1/mcp');
    assert.equal(publicEndpoint(new URL('http://127.0.0.1:8080/mcp')).href, 'http://127.0.0.1:8080/public/v1/mcp');
  });

  it('only forwards tools the hosted server serves anonymously, and they are in the catalogue', () => {
    for (const name of PUBLIC_TOOLS) {
      assert.ok(CATALOG.tools.some((tool) => tool.name === name), `${name} is not in catalog.json`);
    }
  });

  it('answers the guide from the public endpoint instead of asking for a credential', async () => {
    const upstream = await startFakeUpstream();

    after(async () => {
      await upstream.close();
    });

    const { stdio } = await handshake(upstream.url);
    const called = await request(stdio, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'growwer_get_guide', arguments: { topic: 'faq' } },
    });

    const result = called.result as { content: { type: string; text: string }[]; isError?: boolean };

    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?.text, 'ok');
    assert.ok(upstream.requests.some((sent) => sent.method === 'tools/call'), 'the call must reach the upstream');
    assert.ok(upstream.requests.every((sent) => sent.authorization === undefined), 'no credential may be sent');
  });

  it('still refuses every other tool without a credential', async () => {
    const upstream = await startFakeUpstream();

    after(async () => {
      await upstream.close();
    });

    const { stdio } = await handshake(upstream.url);
    const called = await request(stdio, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'growwer_list_projects', arguments: {} },
    });

    const result = called.result as { content: { type: string; text: string }[]; isError?: boolean };

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /GROWWER_API_KEY/);
    assert.ok(!upstream.requests.some((sent) => sent.method === 'tools/call'), 'a refused call must not reach the upstream');
  });

  it('forwards a prompt to the public endpoint, with no credential', async () => {
    const upstream = await startFakeUpstream();

    after(async () => {
      await upstream.close();
    });

    const { stdio } = await handshake(upstream.url);
    const [first] = CATALOG.prompts;

    assert.ok(first !== undefined);

    const rendered = await request(stdio, {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: { name: first.name, arguments: {} },
    });

    const { messages } = rendered.result as { messages: { content: { text: string } }[] };

    assert.equal(messages[0]?.content.text, `the ${first.name} prompt`);

    const sent = upstream.requests.find((frame) => frame.method === 'prompts/get');

    assert.equal(sent?.message.params?.name, first.name);
    assert.ok(upstream.requests.every((frame) => frame.authorization === undefined), 'no credential may be sent');
  });

  it('throws when a prompt cannot be forwarded, since a prompt has no isError', async () => {
    const upstream = await startFakeUpstream({
      script: ({ message, reply }) => {
        if (message.method !== 'prompts/get') {
          return false;
        }

        reply(503, 'the upstream body stays out of the error');

        return true;
      },
    });

    after(async () => {
      await upstream.close();
    });

    const { stdio } = await handshake(upstream.url);
    const [first] = CATALOG.prompts;

    assert.ok(first !== undefined);

    const rendered = await request(stdio, {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: { name: first.name, arguments: {} },
    });

    assert.equal(rendered.result, undefined);
    assert.match(rendered.error?.message ?? '', /HTTP 503/);
    assert.doesNotMatch(rendered.error?.message ?? '', /upstream body/);
  });

  it('reports an unreachable guide as an error result', async () => {
    const upstream = await startFakeUpstream();
    const { url } = upstream;

    await upstream.close();

    const { stdio } = await handshake(url);
    const called = await request(stdio, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'growwer_get_guide', arguments: {} },
    });

    const result = called.result as { content: { type: string; text: string }[]; isError?: boolean };

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /could not be reached/);
  });
});

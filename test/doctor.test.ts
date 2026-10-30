import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArgs } from '../src/config.ts';
import { runDoctor } from '../src/doctor.ts';
import { startFakeUpstream } from './helpers.ts';

const collect = (): { write: (text: string) => void; output: () => string } => {
  const lines: string[] = [];

  return { write: (text) => lines.push(text), output: () => lines.join('\n') };
};

describe('runDoctor', () => {
  it('reports the server, protocol and tool catalogue on success', async () => {
    const upstream = await startFakeUpstream({
      tools: [
        { name: 'list_projects', description: 'List projects.' },
        { name: 'growwer_list_orders', description: 'List your orders.' },
      ],
    });

    try {
      const config = parseArgs(['--url', upstream.url.href], { GROWWER_API_KEY: 'gw_sk_test' });
      const sink = collect();

      assert.equal(await runDoctor(config, sink.write), 0);

      const output = sink.output();

      assert.match(output, /fake-growwer 0\.0\.0/);
      assert.match(output, /2025-06-18/);
      assert.match(output, /Tools {13}2/);
      assert.match(output, /- growwer_list_orders/);
      assert.match(output, /OK — the credential works/);
    } finally {
      await upstream.close();
    }
  });

  it('explains a rejected credential instead of dumping a stack trace', async () => {
    const upstream = await startFakeUpstream({ failOnRequest: { index: 1, status: 401 } });

    try {
      const config = parseArgs(['--url', upstream.url.href], { GROWWER_API_KEY: 'gw_sk_revoked' });
      const sink = collect();

      assert.equal(await runDoctor(config, sink.write), 1);
      assert.match(sink.output(), /rejected the credential \(HTTP 401\)/);
    } finally {
      await upstream.close();
    }
  });

  it('does not contact anything when no credential is configured', async () => {
    const upstream = await startFakeUpstream();

    try {
      const config = parseArgs(['--url', upstream.url.href], {});
      const sink = collect();

      assert.equal(await runDoctor(config, sink.write), 1);
      assert.equal(upstream.requests.length, 0);
      assert.match(sink.output(), /No credential configured/);
    } finally {
      await upstream.close();
    }
  });
});

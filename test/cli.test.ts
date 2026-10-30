import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

const require = createRequire(import.meta.url);
const manifest = require('../package.json') as { name: string; version: string };
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('the built CLI', () => {
  it('prints its version', async () => {
    const { stdout, stderr } = await run(process.execPath, [cli, '--version']);

    assert.equal(stdout.trim(), `${manifest.name} ${manifest.version}`);
    assert.equal(stderr, '');
  });

  it('prints help without touching the network', async () => {
    const { stdout } = await run(process.execPath, [cli, '--help']);

    assert.match(stdout, /Usage/);
    assert.match(stdout, /growwer-mcp doctor/);
    assert.match(stdout, /GROWWER_API_KEY/);
  });

  it('exits 2 with a readable message on bad arguments', async () => {
    await assert.rejects(
      run(process.execPath, [cli, '--header', 'nope']),
      (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr ?? '', /--header expects "Name: value"/);

        return true;
      }
    );
  });

  it('reports a missing credential from doctor without contacting anything', async () => {
    await assert.rejects(
      run(process.execPath, [cli, 'doctor'], { env: { ...process.env, GROWWER_API_KEY: '' } }),
      (error: NodeJS.ErrnoException & { code?: number; stdout?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout ?? '', /No credential configured/);

        return true;
      }
    );
  });
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { startFakeUpstream } from './helpers.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

interface Outcome {
  code: number;
  output: string;
}

/** A throwaway copy of the repository's files, since these scripts read and write beside themselves. */
const sandbox = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'growwer-mcp-scripts-'));

  for (const entry of ['scripts', 'skills', '.github', 'package.json', 'server.json', 'catalog.json', 'Dockerfile']) {
    cpSync(join(root, entry), join(directory, entry), { recursive: true });
  }

  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return directory;
};

const script = async (directory: string, name: string, ...args: string[]): Promise<Outcome> => {
  const result = await run(process.execPath, [join(directory, 'scripts', name), ...args]).catch(
    (error: { code: number; stdout: string; stderr: string }) => error
  );

  return { code: 'code' in result ? result.code : 0, output: `${result.stdout}${result.stderr}` };
};

const readCatalog = (directory: string): { source: string; tools: { name: string }[]; prompts: unknown[] } =>
  JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf8'));

describe('sync-catalog', () => {
  it('keeps the committed source when --url reads another endpoint', async () => {
    const upstream = await startFakeUpstream({ tools: [{ name: 'growwer_get_me', description: 'Your account.' }] });

    after(async () => {
      await upstream.close();
    });

    const directory = sandbox();
    const { source } = readCatalog(directory);
    const { code } = await script(directory, 'sync-catalog.mjs', '--url', new URL('/public/v1/mcp', upstream.url).href);

    assert.equal(code, 0);
    assert.equal(source, 'https://tool.growwer.com/public/v1/mcp');
    assert.equal(readCatalog(directory).source, source);
    assert.deepEqual(
      readCatalog(directory).tools.map((tool) => tool.name),
      ['growwer_get_me']
    );
  });

  it('creates the file when there is none, with the hosted source', async () => {
    const upstream = await startFakeUpstream();

    after(async () => {
      await upstream.close();
    });

    const directory = sandbox();

    rmSync(join(directory, 'catalog.json'));

    const { code } = await script(directory, 'sync-catalog.mjs', '--url', upstream.url.href);

    assert.equal(code, 0);
    assert.equal(readCatalog(directory).source, 'https://tool.growwer.com/public/v1/mcp');
    assert.equal(readCatalog(directory).tools.length, 1);
  });

  it('passes --check on a match, and fails it without touching the file on a mismatch or no file', async () => {
    const upstream = await startFakeUpstream();

    after(async () => {
      await upstream.close();
    });

    const directory = sandbox();
    const before = readFileSync(join(directory, 'catalog.json'), 'utf8');
    const stale = await script(directory, 'sync-catalog.mjs', '--check', '--url', upstream.url.href);

    assert.equal(stale.code, 1);
    assert.equal(readFileSync(join(directory, 'catalog.json'), 'utf8'), before);

    await script(directory, 'sync-catalog.mjs', '--url', upstream.url.href);
    assert.equal((await script(directory, 'sync-catalog.mjs', '--check', '--url', upstream.url.href)).code, 0);

    rmSync(join(directory, 'catalog.json'));
    assert.equal((await script(directory, 'sync-catalog.mjs', '--check', '--url', upstream.url.href)).code, 1);
    assert.equal(existsSync(join(directory, 'catalog.json')), false);
  });
});

describe('check-manifests', () => {
  it('passes on the repository as it stands, with no ChatGPT submission file', async () => {
    const directory = sandbox();

    assert.equal(existsSync(join(directory, 'chatgpt-app-submission.json')), false);
    assert.deepEqual(await script(directory, 'check-manifests.mjs'), {
      code: 0,
      output: `✓ manifests agree on com.growwer/growwer ${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}\n`,
    });
  });

  it('fails on a tool a skill names that the catalogue does not have', async () => {
    const directory = sandbox();
    const skill = join(directory, 'skills', 'growwer-track-orders', 'SKILL.md');

    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nCall \`growwer_not_a_tool\`.\n`);

    const { code, output } = await script(directory, 'check-manifests.mjs');

    assert.equal(code, 1);
    assert.match(output, /skills\/growwer-track-orders\/SKILL\.md names growwer_not_a_tool/);
  });

  it('fails on a prompt with no skill', async () => {
    const directory = sandbox();

    rmSync(join(directory, 'skills', 'growwer-track-orders'), { recursive: true });

    const { code, output } = await script(directory, 'check-manifests.mjs');

    assert.equal(code, 1);
    assert.match(output, /prompt "track_orders" has no skills\/growwer-track-orders\/SKILL\.md/);
  });
});

describe('release.yml', () => {
  it('holds npm, the image and the registry behind the catalogue check', () => {
    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

    assert.match(release, /\n {2}catalog:\n[\s\S]*?npm run check:catalog/);

    for (const job of ['npm', 'ghcr', 'registry']) {
      const needs = new RegExp(`\\n {2}${job}:\\n(?:.*\\n)*? {4}needs: \\[([^\\]]*)\\]`).exec(release)?.[1];

      assert.ok(needs?.split(', ').includes('catalog'), `${job} does not need the catalog job`);
    }
  });
});

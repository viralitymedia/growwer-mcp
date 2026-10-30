import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * package.json is the single source of truth for the version. Reading it at
 * runtime keeps the CLI banner, the `User-Agent` and the npm release from
 * drifting apart the way three hand-maintained constants would.
 */
const manifest = require('../package.json') as { name: string; version: string };

export const PACKAGE_NAME = manifest.name;

export const PACKAGE_VERSION = manifest.version;

export const USER_AGENT = `growwer-mcp/${manifest.version}`;

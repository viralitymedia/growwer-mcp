#!/usr/bin/env node
/**
 * The version appears in four places that the MCP registry cross-checks at
 * publish time: package.json, server.json, the npm package entry and the OCI
 * image tag. A mismatch is only discovered when `mcp-publisher publish` rejects
 * the release, after npm has already been published and cannot be republished
 * at that version — so check before tagging, not after.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'));

const pkg = read('package.json');
const server = read('server.json');
const problems = [];

if (pkg.version !== server.version) {
  problems.push(`package.json version ${pkg.version} != server.json version ${server.version}`);
}

if (pkg.mcpName !== server.name) {
  problems.push(`package.json mcpName "${pkg.mcpName}" != server.json name "${server.name}" (npm ownership check fails without an exact match)`);
}

const npmPackage = server.packages?.find((entry) => entry.registryType === 'npm');

if (npmPackage === undefined) {
  problems.push('server.json has no npm package entry');
} else {
  if (npmPackage.identifier !== pkg.name) {
    problems.push(`server.json npm identifier "${npmPackage.identifier}" != package.json name "${pkg.name}"`);
  }

  if (npmPackage.version !== pkg.version) {
    problems.push(`server.json npm package version ${npmPackage.version} != ${pkg.version}`);
  }
}

const ociPackage = server.packages?.find((entry) => entry.registryType === 'oci');

if (ociPackage !== undefined && !ociPackage.identifier.endsWith(`:${pkg.version}`)) {
  problems.push(`server.json oci identifier "${ociPackage.identifier}" is not tagged :${pkg.version}`);
}

// server.json advertises an image tag; the release workflow must actually push
// that exact string, or the registry step fails after npm has burned the version.
const release = readFileSync(fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url)), 'utf8');

if (ociPackage !== undefined) {
  const tag = ociPackage.identifier.slice(ociPackage.identifier.lastIndexOf(':') + 1);
  const publishesBareVersion = release.includes('${{ needs.version.outputs.version }}');

  if (tag === pkg.version && !publishesBareVersion) {
    problems.push('server.json advertises the bare version image tag, but release.yml does not push it');
  }
}

if (server.description.length > 100) {
  problems.push(`server.json description is ${server.description.length} characters; the registry schema caps it at 100`);
}

// catalog.json is require()d at startup by the keyless setup server. Leaving it out of `files`
// publishes a package that throws MODULE_NOT_FOUND on `npx @growwer/mcp` — and it would be found
// by a user, not by CI, because everything before the publish runs from a checkout that has it.
if (!pkg.files.includes('catalog.json')) {
  problems.push('package.json "files" does not include catalog.json, which the setup server reads at runtime');
}

const catalog = read('catalog.json');

if (!Array.isArray(catalog.tools) || catalog.tools.length === 0) {
  problems.push('catalog.json advertises no tools');
}

// A skill is prose a model follows, so a renamed tool breaks it without any test noticing: the
// model calls a tool that is not there. Every prompt has its skill, and every tool a skill names
// must exist.
const skillsDirectory = fileURLToPath(new URL('../skills/', import.meta.url));
const knownTools = new Set((catalog.tools ?? []).map((tool) => tool.name));

for (const prompt of catalog.prompts ?? []) {
  const skill = `growwer-${prompt.name.replaceAll('_', '-')}`;

  for (const file of ['SKILL.md', 'agents/openai.yaml']) {
    if (!existsSync(join(skillsDirectory, skill, file))) {
      problems.push(`prompt "${prompt.name}" has no skills/${skill}/${file}`);
    }
  }
}

for (const skill of existsSync(skillsDirectory) ? readdirSync(skillsDirectory) : []) {
  const path = join(skillsDirectory, skill, 'SKILL.md');

  if (!existsSync(path)) {
    continue;
  }

  for (const [tool] of readFileSync(path, 'utf8').matchAll(/\bgrowwer_[a-z0-9_]+\b/g)) {
    if (!knownTools.has(tool)) {
      problems.push(`skills/${skill}/SKILL.md names ${tool}, which catalog.json does not have`);
    }
  }
}


// The Docker image builds its own file list rather than using `files`.
const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');

if (!/^COPY .*catalog\.json/m.test(dockerfile)) {
  problems.push('Dockerfile does not copy catalog.json into the runtime image');
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`✗ ${problem}\n`);
  }

  process.exit(1);
}

process.stdout.write(`✓ manifests agree on ${server.name} ${pkg.version}\n`);

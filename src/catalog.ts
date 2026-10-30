import { createRequire } from 'node:module';

import type { JsonSchemaType, ToolAnnotations } from '@modelcontextprotocol/server';

const require = createRequire(import.meta.url);

export interface CatalogTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaType;
  readonly outputSchema?: JsonSchemaType;
  readonly annotations?: ToolAnnotations;
}

export interface CatalogPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface CatalogPrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly CatalogPromptArgument[];
}

export interface Catalog {
  /** The endpoint the catalogue was captured from, and the one `sync:catalog` refreshes it against. */
  readonly source: string;
  readonly tools: readonly CatalogTool[];
  readonly prompts: readonly CatalogPrompt[];
}

/**
 * What the hosted Growwer server advertises, captured at release time.
 *
 * The bridge itself never needs this: a credentialed run splices transports and the real
 * `tools/list` crosses verbatim. It exists for the uncredentialed run, where there is no upstream
 * session to ask — and a server that answers `tools/list` with a lone `growwer_setup` tool is
 * indistinguishable, to an MCP registry or a directory scanner, from a server with nothing to
 * offer. Shipping the catalogue means `npx @growwer/mcp` introspects to the same tools a
 * credentialed run serves, with the calls themselves still refused until a key is configured.
 *
 * Refresh it with `npm run sync:catalog`, which reads the endpoint in `source`. CI checks the
 * committed copy still matches, so it cannot drift silently.
 */
export const CATALOG = require('../catalog.json') as Catalog;

/**
 * JSON Schema for a prompt's arguments, which the wire format gives as a flat list rather than a
 * schema. Every Growwer prompt argument is a plain string, and today no prompt takes any.
 */
export const promptArgumentsSchema = (prompt: CatalogPrompt): JsonSchemaType => {
  const properties: Record<string, JsonSchemaType> = {};
  const required: string[] = [];

  for (const argument of prompt.arguments ?? []) {
    properties[argument.name] =
      argument.description === undefined
        ? { type: 'string' }
        : { type: 'string', description: argument.description };

    if (argument.required === true) {
      required.push(argument.name);
    }
  }

  return { type: 'object', properties, required };
};

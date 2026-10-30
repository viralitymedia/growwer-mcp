/**
 * Canonical on-disk form for `catalog.json`.
 *
 * `sync:catalog` rewrites the file and `check:catalog` compares it byte for byte, so both have to
 * agree on key order and on which absent fields are omitted rather than written as `null`. Keeping
 * that in one place is what makes "the committed catalogue is stale" a meaningful failure instead
 * of a diff in how two scripts happened to serialise the same data.
 */

const pick = (source, keys) => {
  const target = {};

  for (const key of keys) {
    if (source[key] !== undefined) {
      target[key] = source[key];
    }
  }

  return target;
};

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const normalizeTool = (tool) => pick(tool, ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations']);

const normalizePrompt = (prompt) => {
  const normalized = pick(prompt, ['name', 'title', 'description']);

  if (prompt.arguments !== undefined) {
    normalized.arguments = prompt.arguments.map((argument) => pick(argument, ['name', 'description', 'required']));
  }

  return normalized;
};

export const normalizeCatalog = ({ source, tools, prompts }) => ({
  source,
  tools: [...tools].sort(byName).map(normalizeTool),
  prompts: [...prompts].sort(byName).map(normalizePrompt),
});

export const serializeCatalog = (catalog) => `${JSON.stringify(normalizeCatalog(catalog), null, 4)}\n`;

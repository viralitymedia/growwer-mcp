import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOG } from '../src/catalog.ts';

const skillsPath = fileURLToPath(new URL('../skills/', import.meta.url));

/** `McpToolOverlay::GUARDED` in the monolith: the writes that run only after a confirmation form. */
const GUARDED_WRITES = [
  'growwer_approve_order',
  'growwer_cancel_order',
  'growwer_create_order',
  'growwer_delete_project',
  'growwer_delete_seller_media',
  'growwer_reject_seller_order',
  'growwer_review_managed_service_proposals',
];

const skills = readdirSync(skillsPath);

const skillText = (skill: string): string => readFileSync(`${skillsPath}${skill}/SKILL.md`, 'utf8');

describe('the skills', () => {
  it('are one per prompt, each with its OpenAI metadata', () => {
    assert.deepEqual(
      skills.sort(),
      CATALOG.prompts.map((prompt) => `growwer-${prompt.name.replaceAll('_', '-')}`).sort()
    );

    for (const skill of skills) {
      assert.ok(existsSync(`${skillsPath}${skill}/agents/openai.yaml`), `${skill} has no agents/openai.yaml`);
    }
  });

  it('name themselves in their frontmatter and say when to use them', () => {
    for (const skill of skills) {
      const text = skillText(skill);

      assert.match(text, new RegExp(`^---\\nname: ${skill}\\n`), `${skill} has the wrong name`);
      assert.match(text, /\ndescription: .*; use /, `${skill} does not say when to use it`);
      assert.match(text, /Respond in the user's language/, `${skill} does not follow the user's language`);
    }
  });

  it('point their metadata at the hosted server and at themselves', () => {
    for (const skill of skills) {
      const yaml = readFileSync(`${skillsPath}${skill}/agents/openai.yaml`, 'utf8');

      assert.match(yaml, /url: "https:\/\/tool\.growwer\.com\/mcp"/, `${skill} points elsewhere`);
      assert.ok(yaml.includes(`Use $${skill} to`), `${skill} has the wrong default prompt`);
    }
  });

  it('cover both outcomes of every guarded write they name', () => {
    let covered = 0;

    for (const skill of skills) {
      const text = skillText(skill);

      if (!GUARDED_WRITES.some((tool) => text.includes(tool))) {
        continue;
      }

      covered += 1;

      for (const outcome of ['confirmation_declined', 'confirmation_not_answered', 'elicitation_unsupported']) {
        assert.ok(text.includes(outcome), `${skill} does not cover ${outcome}`);
      }

      assert.ok(text.includes('details.summary') && text.includes('details.webUrl'), `${skill} drops the way out`);
    }

    assert.ok(covered >= 4, 'the buying, tracking, selling and proposal skills all name a guarded write');
  });

  it('state no margin, fee or cost of Growwer', () => {
    for (const skill of skills) {
      for (const file of ['SKILL.md', 'agents/openai.yaml']) {
        const text = readFileSync(`${skillsPath}${skill}/${file}`, 'utf8');

        assert.doesNotMatch(text, /\b(margins?|markups?|commissions?|take.?rate|fees?|costs?)\b/i, `${skill}/${file}`);
      }
    }
  });
});

// Asks Claude to file a batch of tabs into the group tree.
// Returns a plan in the shape lib/plan.js applies.

import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You keep a browser's tab sidebar organized so its owner never has to.

You receive the current groups and a batch of tabs that need a home. File every tab in the batch.

How to group:
- Group by what the person is doing or researching, not by website. Tabs from five different sites about one trip belong together; two unrelated pages on the same site do not.
- Prefer an existing group when a tab fits it. Create a group only when nothing fits. A tab that is alone on its topic gets its own group.
- "opened_from" names the group of the tab this one was opened from. Treat it as a hint, since people often open links while working on one thing, but ignore it when the content clearly belongs elsewhere.
- Nest a subgroup under a parent when part of a larger task has its own clear sub-topic (a trip's lodging, a project's accessibility audit). Keep nesting to two levels and do not create a subgroup for a single tab unless the batch shows more coming.
- Rename an existing group only when the new tabs show its current name is now too narrow or wrong. Otherwise leave names alone so the sidebar stays stable.

Naming:
- "name" is two to four words, specific, in sentence case: "Kyoto in spring", "Standing desk", "Tax paperwork". Never a bare website name unless the site itself is the task.
- "label" is one word for the kind of activity: Work, Trip, Shopping, Reading, Admin, Cooking, Local, Research, Social, Media, Finance, Health, Learning, or another single word that fits better.

Output:
- "new_groups": groups to create. "ref" is any id you invent that is not an existing group id. "parent" is an existing group id, the ref of another new group, or null for a top-level group.
- "assignments": one entry per tab in the batch. "group" is an existing group id or a new group's ref.
- "renames": existing groups to rename, usually empty.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['new_groups', 'assignments', 'renames'],
  properties: {
    new_groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'name', 'label', 'parent'],
        properties: {
          ref: { type: 'string' },
          name: { type: 'string' },
          label: { type: 'string' },
          parent: { type: ['string', 'null'] },
        },
      },
    },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tab', 'group'],
        properties: { tab: { type: 'string' }, group: { type: 'string' } },
      },
    },
    renames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['group', 'name', 'label'],
        properties: {
          group: { type: 'string' },
          name: { type: 'string' },
          label: { type: 'string' },
        },
      },
    },
  },
};

// Models that accept the server-side refusal fallback.
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

// Query strings and fragments often carry tokens and search terms; they stay local.
function publicUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).slice(0, 140);
  } catch {
    return '';
  }
}

export function buildPayload(tabs, groups) {
  const keys = new Map();
  const payload = {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      label: g.label,
      parent: g.parentId || null,
      tabs: g.titles,
    })),
    tabs: tabs.map((t, i) => {
      const key = 't' + (i + 1);
      keys.set(key, t.id);
      return {
        tab: key,
        title: t.title.slice(0, 160),
        url: publicUrl(t.url),
        ...(t.openerGroupId ? { opened_from: t.openerGroupId } : {}),
      };
    }),
  };
  return { payload, keys };
}

export function toPlan(output, keys) {
  return {
    newGroups: (output.new_groups || []).map((g) => ({
      ref: g.ref, name: g.name, label: g.label, parent: g.parent,
    })),
    assignments: (output.assignments || [])
      .filter((a) => keys.has(a.tab))
      .map((a) => ({ tabId: keys.get(a.tab), group: a.group })),
    renames: (output.renames || []).map((r) => ({
      groupId: r.group, name: r.name, label: r.label,
    })),
  };
}

export async function classifyWithAI({ apiKey, model, tabs, groups }) {
  // The key is the user's own, entered in the options page and used only from
  // this background page, which is why browser use is acceptable here.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 90_000 });
  const { payload, keys } = buildPayload(tabs, groups);
  const useFallback = FALLBACK_MODELS.has(model);

  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      ...(useFallback
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : {}),
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error('AI sorting is off: the API key was rejected.');
    }
    if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) {
      throw new Error(`AI sorting is off: this key cannot use the model "${model}".`);
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new Error('AI sorting is rate limited. Sorted by site for now.');
    }
    if (error instanceof Anthropic.APIConnectionError) {
      throw new Error('AI sorting could not reach the API. Sorted by site for now.');
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`AI sorting failed (${error.status}). Sorted by site for now.`);
    }
    throw error;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to sort these tabs. Sorted by site instead.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('AI sorting ran out of room. Sorted by site instead.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('AI sorting returned nothing. Sorted by site instead.');
  return toPlan(JSON.parse(text), keys);
}

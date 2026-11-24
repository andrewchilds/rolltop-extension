// Asks Claude to file a batch of tabs into the group tree, and to split a group
// that has grown large. Both return a plan in the shape lib/plan.js applies.

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
- "assignments": one entry per tab in the batch. "group" is an existing group id or a new group's ref. "reason" is one short sentence on why the tab goes there; when it goes in a new group, say why no existing group fit.
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
        required: ['tab', 'group', 'reason'],
        properties: { tab: { type: 'string' }, group: { type: 'string' }, reason: { type: 'string' } },
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

// A second, smaller request: one group has grown large, and the model is asked
// whether the tabs sitting directly in it fall into sub-groups.
const SPLIT_SYSTEM = `You keep a browser's tab sidebar organized so its owner never has to.

One group has grown large. You receive the group, the sub-groups it already has, and the tabs sitting directly in it. Decide whether some of those tabs form sub-topics of the group that would be easier to scan under their own heading.

How to split:
- A sub-group is a narrower part of what the group is about: a trip's lodging, a purchase's reviews, a project's bug reports. Split by what the person is doing, not by website.
- A new sub-group needs at least three tabs. Move a tab into an existing sub-group when it fits one.
- Leave a tab where it is when it belongs to no cluster. Most groups keep some tabs directly in them, and moving nothing is a fine answer when the group is simply one topic.
- Prefer two to four sub-groups over many small ones.

Naming:
- "name" is two to four words, specific, in sentence case, and does not repeat the parent group's name: under "Kyoto in spring", use "Places to stay", not "Kyoto places to stay".
- "label" is one word for the kind of activity, usually the parent's label.

Output:
- "new_groups": sub-groups to create. "ref" is any id you invent that is not an existing id.
- "moves": only the tabs that move. "group" is an existing sub-group id or a new sub-group's ref.`;

const SPLIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['new_groups', 'moves'],
  properties: {
    new_groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'name', 'label'],
        properties: { ref: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' } },
      },
    },
    moves: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tab', 'group'],
        properties: { tab: { type: 'string' }, group: { type: 'string' } },
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

// Tabs go out under short keys (t1, t2, ...); `keys` maps them back to tab ids.
function tabRows(tabs, keys) {
  return tabs.map((t, i) => {
    const key = 't' + (i + 1);
    keys.set(key, t.id);
    return {
      tab: key,
      title: t.title.slice(0, 160),
      url: publicUrl(t.url),
      ...(t.openerGroupId ? { opened_from: t.openerGroupId } : {}),
    };
  });
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
    tabs: tabRows(tabs, keys),
  };
  return { payload, keys };
}

export function buildSplitPayload(group, subgroups, tabs) {
  const keys = new Map();
  const payload = {
    group: { id: group.id, name: group.name, label: group.label },
    subgroups: subgroups.map((g) => ({ id: g.id, name: g.name, label: g.label, tabs: g.titles })),
    tabs: tabRows(tabs, keys),
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
      .map((a) => ({ tabId: keys.get(a.tab), group: a.group, reason: a.reason || '' })),
    renames: (output.renames || []).map((r) => ({
      groupId: r.group, name: r.name, label: r.label,
    })),
  };
}

// The same plan shape, for a split: every new group is a child of `groupId`,
// and only the tabs that move are assigned.
export function toSplitPlan(output, keys, groupId) {
  return {
    newGroups: (output.new_groups || []).map((g) => ({
      ref: g.ref, name: g.name, label: g.label, parent: groupId,
    })),
    assignments: (output.moves || [])
      .filter((m) => keys.has(m.tab))
      .map((m) => ({ tabId: keys.get(m.tab), group: m.group })),
    renames: [],
  };
}

// An error the sidebar can show. `retry` marks one worth trying again later
// without the user changing anything: a rate limit, the network, the server.
function failure(message, retry = false) {
  return Object.assign(new Error(message), { retry });
}

// One structured-output request. Returns the parsed JSON and what it cost.
async function ask({ apiKey, model, system, schema, payload }) {
  // The key is the user's own, entered in the options page and used only from
  // this background page, which is why browser use is acceptable here.
  // A failed batch is filed by site and tried again later by the caller, so
  // one quick retry here is enough.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 60_000, maxRetries: 1 });
  const useFallback = FALLBACK_MODELS.has(model);
  const started = Date.now();

  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      ...(useFallback
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : {}),
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw failure('AI sorting is off: the API key was rejected.');
    }
    if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) {
      throw failure(`AI sorting is off: this key cannot use the model "${model}".`);
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw failure('AI sorting is rate limited. Sorted by site for now.', true);
    }
    if (error instanceof Anthropic.APIConnectionError) {
      throw failure('AI sorting could not reach the API. Sorted by site for now.', true);
    }
    if (error instanceof Anthropic.APIError) {
      throw failure(`AI sorting failed (${error.status}). Sorted by site for now.`, error.status >= 500);
    }
    throw error;
  }

  if (response.stop_reason === 'refusal') {
    throw failure('The model declined to sort these tabs. Sorted by site instead.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw failure('AI sorting ran out of room. Sorted by site instead.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw failure('AI sorting returned nothing. Sorted by site instead.');
  const u = response.usage || {};
  return {
    output: JSON.parse(text),
    usage: {
      // Everything read as input, cached or not; output includes thinking.
      input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0,
      ms: Date.now() - started,
      // Differs from the model asked for when a refusal fallback answered.
      model: response.model || model,
    },
  };
}

export async function classifyWithAI({ apiKey, model, tabs, groups }) {
  const { payload, keys } = buildPayload(tabs, groups);
  const { output, usage } = await ask({ apiKey, model, system: SYSTEM, schema: SCHEMA, payload });
  return { ...toPlan(output, keys), usage };
}

// `group` is { id, name, label }, `subgroups` its children with sample titles,
// `tabs` the tabs sitting directly in it.
export async function splitWithAI({ apiKey, model, group, subgroups, tabs }) {
  const { payload, keys } = buildSplitPayload(group, subgroups, tabs);
  const { output, usage } = await ask({ apiKey, model, system: SPLIT_SYSTEM, schema: SPLIT_SCHEMA, payload });
  return { ...toSplitPlan(output, keys, group.id), usage };
}

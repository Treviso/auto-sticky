// ---------------------------------------------------------------------------
// rules.ts - YAML parsing + post-matching logic
// ---------------------------------------------------------------------------
// We intentionally support only the AutoModerator fields that relate to:
//   • post title  (title (contains|starts-with|ends-with|full-exact|[regex]))
//   • post flair  (post_flair_id)
//   • comment output (comment, comment_locked, comment_sticky)
//
// Every YAML key in the "conditions" section follows AutoModerator naming
// exactly so that mods can copy/paste existing Automoderator snippets.
// ---------------------------------------------------------------------------

import yaml from 'js-yaml';
import type { Rule, TitleCondition, TitleModifier, PostSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Key → modifier mapping  (covers every AutoModerator title variant we want)
// ---------------------------------------------------------------------------
const TITLE_KEY_MAP: ReadonlyArray<[string, TitleModifier]> = [
  ['title (contains)',     'contains'],
  ['title (not-contains)', 'not-contains'],
  ['title (starts-with)',  'starts-with'],
  ['title (ends-with)',    'ends-with'],
  ['title (full-exact)',   'full-exact'],
  ['title [regex]',        'regex'],
  ['title (regex)',        'regex'],      // tolerant alias
  ['title [not-regex]',   'not-regex'],
  ['title (not-regex)',   'not-regex'],   // tolerant alias
];

// ---------------------------------------------------------------------------
// Public: parse a multi-document YAML string into validated Rule objects
// ---------------------------------------------------------------------------
export function parseRules(rulesYaml: string): Rule[] {
  // AutoModerator separates rules with "---"
  const docs = rulesYaml.split(/^---\s*$/m);
  const rules: Rule[] = [];

  for (const doc of docs) {
    const trimmed = doc.trim();
    if (!trimmed) continue; 

    let parsed: unknown;
    try {
      parsed = yaml.load(trimmed);
    } catch (err) {
      console.error('[AutoSticky] YAML parse error - skipping block:', err);
      continue;
    }

    // If a block is entirely comments, yaml.load returns undefined
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const rule = buildRule(parsed as Record<string, unknown>);
    if (rule) rules.push(rule);
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Public: find the first rule that matches a post (first-match-wins)
// ---------------------------------------------------------------------------
export function matchPost(post: PostSnapshot, rules: Rule[]): Rule | null {
  for (const rule of rules) {
    if (ruleMatches(post, rule)) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public: expand {{template}} variables in a comment body
// ---------------------------------------------------------------------------
export function expandTemplate(template: string, post: PostSnapshot): string {
  return template
    .replace(/\{\{author\}\}/gi,    post.authorName)
    .replace(/\{\{subreddit\}\}/gi, post.subredditName)
    .replace(/\{\{title\}\}/gi,     post.title)
    .replace(/\{\{url\}\}/gi,       post.url);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildRule(data: Record<string, unknown>): Rule | null {
  // comment is the only mandatory action field
  const commentRaw = data['comment'];
  if (typeof commentRaw !== 'string' || !commentRaw.trim()) {
    console.warn('[AutoSticky] Rule skipped - missing "comment" field');
    return null;
  }

  // comment_sticky / comment_locked both default to true (safest mod behaviour)
  const rule: Rule = {
    comment:        commentRaw,
    comment_locked: data['comment_locked'] !== false,
    comment_stickied: data['comment_stickied'] !== false,
  };

  // --- title conditions ---
  const titleConditions: TitleCondition[] = [];
  for (const [key, modifier] of TITLE_KEY_MAP) {
    const val = data[key];
    if (val === undefined || val === null) continue;
    const values = normaliseStringList(val);
    if (values.length > 0) titleConditions.push({ modifier, values });
  }
  if (titleConditions.length > 0) rule.title = titleConditions;

  // --- flair condition ---
  const flairRaw = data['post_flair_id'];
  if (flairRaw !== undefined && flairRaw !== null) {
    const ids = normaliseStringList(flairRaw);
    if (ids.length > 0) rule.post_flair_id = ids;
  }

  // A rule is useless without at least one condition
  if (!rule.title && !rule.post_flair_id) {
    console.warn('[AutoSticky] Rule skipped - no conditions (title / post_flair_id)');
    return null;
  }

  return rule;
}

/** Accept a bare string OR a YAML list of strings */
function normaliseStringList(val: unknown): string[] {
  if (typeof val === 'string') return [val];
  if (Array.isArray(val))     return val.map(String).filter(Boolean);
  return [String(val)].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function ruleMatches(post: PostSnapshot, rule: Rule): boolean {
  // All title conditions must pass (AND semantics, same as AutoModerator)
  if (rule.title) {
    for (const cond of rule.title) {
      if (!checkTitleCondition(post.title, cond)) return false;
    }
  }

  // Flair: any of the listed IDs must match (OR semantics).
  // If the post has no flair template (empty string), skip any rule that requires one.
  if (rule.post_flair_id) {
    const postFlair = post.linkFlairTemplateId || '';
    if (!postFlair || !rule.post_flair_id.includes(postFlair)) return false;
  }

  return true;
}

function checkTitleCondition(title: string, cond: TitleCondition): boolean {
  const lower = title.toLowerCase();

  switch (cond.modifier) {
    case 'contains':
      // ANY of the values must appear
      return cond.values.some(v => lower.includes(v.toLowerCase()));

    case 'not-contains':
      // NONE of the values may appear
      return cond.values.every(v => !lower.includes(v.toLowerCase()));

    case 'starts-with':
      return cond.values.some(v => lower.startsWith(v.toLowerCase()));

    case 'ends-with':
      return cond.values.some(v => lower.endsWith(v.toLowerCase()));

    case 'full-exact':
      return cond.values.some(v => lower === v.toLowerCase());

    case 'regex':
      return cond.values.some(v => safeRegex(v)?.test(title) ?? false);

    case 'not-regex':
      return cond.values.every(v => !(safeRegex(v)?.test(title) ?? false));
  }
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    console.error('[AutoSticky] Invalid regex pattern:', pattern);
    return null;
  }
}

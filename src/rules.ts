// ---------------------------------------------------------------------------
// rules.ts - YAML parsing + post-matching logic
// ---------------------------------------------------------------------------
// We intentionally support only the AutoModerator fields that relate to:
//   • post title  (title (contains|not-contains|starts-with|ends-with|full-exact|[regex]))
//   • post body   (body  (contains|not-contains|starts-with|ends-with|full-exact|[regex]))
//   • post flair  (post_flair_id)
//   • comment output (comment, comment_locked, comment_stickied)
//
// Every YAML key in the "conditions" section follows AutoModerator naming
// exactly so that mods can copy/paste existing AutoModerator snippets.
// ---------------------------------------------------------------------------

import yaml from 'js-yaml';
import type { Rule, TextCondition, TextModifier, PostSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Key → modifier mappings  (cover every AutoModerator variant we support)
// ---------------------------------------------------------------------------
const TITLE_KEY_MAP: ReadonlyArray<[string, TextModifier]> = [
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

const BODY_KEY_MAP: ReadonlyArray<[string, TextModifier]> = [
  ['body (contains)',     'contains'],
  ['body (not-contains)', 'not-contains'],
  ['body (starts-with)',  'starts-with'],
  ['body (ends-with)',    'ends-with'],
  ['body (full-exact)',   'full-exact'],
  ['body [regex]',        'regex'],
  ['body (regex)',        'regex'],       // tolerant alias
  ['body [not-regex]',   'not-regex'],
  ['body (not-regex)',   'not-regex'],    // tolerant alias
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
// Public: validate a rules YAML string, throwing on any error.
// Called by the settings onValidate handler so mods see errors inline.
// Unlike parseRules (which swallows errors at runtime to stay resilient),
// this function throws on the first problem it finds.
// ---------------------------------------------------------------------------
export function validateRules(rulesYaml: string): void {
  const docs = rulesYaml.split(/^---\s*$/m);
  let validRuleCount = 0;

  for (const doc of docs) {
    const trimmed = doc.trim();
    if (!trimmed) continue;

    // 1. YAML syntax
    let parsed: unknown;
    try {
      parsed = yaml.load(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`YAML syntax error: ${msg}`);
    }

    // Pure-comment blocks produce undefined - skip silently (same as parseRules)
    if (parsed === undefined || parsed === null) continue;

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Each rule block must be a YAML mapping (key: value pairs), not a plain value or list.');
    }

    const data = parsed as Record<string, unknown>;

    // 2. A comment field is mandatory
    const commentRaw = data['comment'];
    if (typeof commentRaw !== 'string' || !commentRaw.trim()) {
      throw new Error('Every rule must have a non-empty "comment" field.');
    }

    // 3. At least one condition must be present
    const hasTitleCondition = TITLE_KEY_MAP.some(([key]) => data[key] !== undefined && data[key] !== null);
    const hasBodyCondition  = BODY_KEY_MAP.some( ([key]) => data[key] !== undefined && data[key] !== null);
    const hasFlairCondition = data['post_flair_id'] !== undefined && data['post_flair_id'] !== null;
    if (!hasTitleCondition && !hasBodyCondition && !hasFlairCondition) {
      throw new Error('Every rule must have at least one condition (a "title (...)", "body (...)", or "post_flair_id" key).');
    }

    // 4. Regex patterns must compile (checks both title and body)
    for (const keyMap of [TITLE_KEY_MAP, BODY_KEY_MAP]) {
      for (const [key, modifier] of keyMap) {
        if (modifier !== 'regex' && modifier !== 'not-regex') continue;
        const val = data[key];
        if (val === undefined || val === null) continue;
        const patterns = typeof val === 'string' ? [val] : Array.isArray(val) ? val.map(String) : [String(val)];
        for (const pattern of patterns) {
          try {
            new RegExp(pattern, 'iu');
          } catch {
            try {
              new RegExp(pattern, 'i');
            } catch {
              throw new Error(`Invalid regex pattern in "${key}": /${pattern}/`);
            }
          }
        }
      }
    }

    validRuleCount++;
  }

  if (validRuleCount === 0) {
    throw new Error('No valid rules found. Check that each block has a "comment" field and at least one condition.');
  }
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
  const titleConditions: TextCondition[] = [];
  for (const [key, modifier] of TITLE_KEY_MAP) {
    const val = data[key];
    if (val === undefined || val === null) continue;
    const values = normaliseStringList(val);
    if (values.length > 0) titleConditions.push({ modifier, values });
  }
  if (titleConditions.length > 0) rule.title = titleConditions;

  // --- body conditions ---
  const bodyConditions: TextCondition[] = [];
  for (const [key, modifier] of BODY_KEY_MAP) {
    const val = data[key];
    if (val === undefined || val === null) continue;
    const values = normaliseStringList(val);
    if (values.length > 0) bodyConditions.push({ modifier, values });
  }
  if (bodyConditions.length > 0) rule.body = bodyConditions;

  // --- flair condition ---
  const flairRaw = data['post_flair_id'];
  if (flairRaw !== undefined && flairRaw !== null) {
    const ids = normaliseStringList(flairRaw);
    if (ids.length > 0) rule.post_flair_id = ids;
  }

  // A rule is useless without at least one condition
  if (!rule.title && !rule.body && !rule.post_flair_id) {
    console.warn('[AutoSticky] Rule skipped - no conditions (title / body / post_flair_id)');
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
      if (!checkTextCondition(post.title, cond)) return false;
    }
  }

  // All body conditions must pass (AND semantics).
  // Link/image posts have an empty body - body conditions won't match them
  // unless a not-contains / not-regex rule is used (same behaviour as AutoModerator).
  if (rule.body) {
    for (const cond of rule.body) {
      if (!checkTextCondition(post.body, cond)) return false;
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

function checkTextCondition(text: string, cond: TextCondition): boolean {
  const lower = text.toLowerCase();

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
      return cond.values.some(v => safeRegex(v)?.test(text) ?? false);

    case 'not-regex':
      return cond.values.every(v => !(safeRegex(v)?.test(text) ?? false));
  }
}

function safeRegex(pattern: string): RegExp | null {
  // Try unicode-aware first, fall back for patterns that aren't u-compatible
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    try {
      return new RegExp(pattern, 'i');
    } catch {
      console.error('[AutoSticky] Invalid regex pattern:', pattern);
      return null;
    }
  }
}

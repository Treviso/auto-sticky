// ---------------------------------------------------------------------------
// Rule types - mirrors the subset of AutoModerator YAML we support
// ---------------------------------------------------------------------------

/**
 * Text-check modifiers supported for both title and body fields.
 * "contains" / "not-contains" / etc. are **case-insensitive** substring
 * checks; [regex] variants compile the value as a RegExp.
 */
export type TextModifier =
  | 'contains'
  | 'not-contains'
  | 'starts-with'
  | 'ends-with'
  | 'full-exact'
  | 'regex'
  | 'not-regex';

export interface TextCondition {
  modifier: TextModifier;
  /** One or more values - AutoModerator allows a YAML list or a bare string. */
  values: string[];
}

export interface Rule {
  // ---- conditions (at least one must be present) ----
  /** Zero or more title checks - ALL of them must pass (AND). */
  title?: TextCondition[];
  /** Zero or more body checks - ALL of them must pass (AND). */
  body?: TextCondition[];
  /** One or more flair template IDs - ANY match is enough (OR). */
  post_flair_id?: string[];

  // ---- actions ----
  /** The comment body. Supports {{author}}, {{subreddit}}, {{title}}, {{url}}. */
  comment: string;
  /** Lock the comment after posting? Defaults to true. */
  comment_locked: boolean;
  /** Sticky (pin) the comment after posting? Defaults to true. */
  comment_stickied: boolean;
}

/** Minimal post snapshot the trigger handler passes into rule matching. */
export interface PostSnapshot {
  id: string;
  title: string;
  /** Self-text body of the post. Empty string for link/image posts. */
  body: string;
  authorName: string;
  subredditName: string;
  url: string;
  linkFlairTemplateId?: string;
}

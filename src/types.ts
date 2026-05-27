// ---------------------------------------------------------------------------
// Rule types - mirrors the subset of AutoModerator YAML we support
// ---------------------------------------------------------------------------

/**
 * All title-check modifiers that AutoModerator understands and that we
 * implement.  "contains" / "not-contains" / etc. are **case-insensitive**
 * substring checks; [regex] variants compile the value as a RegExp.
 */
export type TitleModifier =
  | 'contains'
  | 'not-contains'
  | 'starts-with'
  | 'ends-with'
  | 'full-exact'
  | 'regex'
  | 'not-regex';

export interface TitleCondition {
  modifier: TitleModifier;
  /** One or more values - AutoModerator allows a YAML list or a bare string. */
  values: string[];
}

export interface Rule {
  // ---- conditions (at least one must be present) ----
  /** Zero or more title checks - ALL of them must pass (AND). */
  title?: TitleCondition[];
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
  authorName: string;
  subredditName: string;
  url: string;
  linkFlairTemplateId?: string;
}

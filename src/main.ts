// ---------------------------------------------------------------------------
// main.ts - Devvit entry point for the AutoSticky app
// ---------------------------------------------------------------------------
// Flow:
//   1. Mod configures rules in the Subreddit Settings page (YAML textarea).
//   2. An optional catch-all comment (markdown) can be set below the YAML field.
//   3. When a new post is submitted the PostSubmit trigger fires.
//   4. We parse the rules, walk them in order (first-match-wins).
//   5. On a match we post a mod comment and optionally sticky + lock it.
//   6. If NO rule matched but a catch-all comment is configured, that fires.
//   7. A Redis key prevents a second comment if the trigger somehow fires twice.
// ---------------------------------------------------------------------------

import { Devvit, SettingScope } from '@devvit/public-api';
import { parseRules, matchPost, expandTemplate } from './rules.js';
import type { PostSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Devvit capabilities we need
// ---------------------------------------------------------------------------
Devvit.configure({
  redditAPI: true,
  redis:     true,
});

// ---------------------------------------------------------------------------
// Subreddit-scoped settings  (accessible via Mod Tools → App Settings)
// ---------------------------------------------------------------------------
Devvit.addSettings([
  {
    type:     'paragraph',
    name:     'rules',
    label:    'Automated Sticky Comments Rules (YAML)',
    helpText: 'Define rules using YAML. Separate each rule with ---. Supported keys: title (contains/starts-with/ends-with/full-exact/[regex]), post_flair_id.',
    scope:    SettingScope.Subreddit,
  },
  {
    type:     'paragraph',
    name:     'catch_all_comment',
    label:    'Default Comment (optional)',
    helpText: 'Supports Markdown. If no rules match, this comment will be posted automatically. Leave blank to disable.',
    scope:    SettingScope.Subreddit,
  },
  {
    type:         'boolean',
    name:         'catch_all_stickied',
    label:        'Sticky Default Comment',
    helpText:     'Pin the Default Comment to the top of the thread as a mod comment.',
    defaultValue: true,
    scope:        SettingScope.Subreddit,
  },
  {
    type:         'boolean',
    name:         'catch_all_locked',
    label:        'Lock Default Comment',
    helpText:     'Prevent replies to the Default Comment.',
    defaultValue: true,
    scope:        SettingScope.Subreddit,
  },
]);

// ---------------------------------------------------------------------------
// PostSubmit trigger - main logic
// ---------------------------------------------------------------------------
Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    const lightPost = event.post;
    if (!lightPost) return;

    // ------------------------------------------------------------------
    // 1. Fetch the FULL post object to ensure author/subreddit are populated
    // ------------------------------------------------------------------
    const fullPost = await context.reddit.getPostById(lightPost.id);

     // ------------------------------------------------------------------
    // 2. Build post snapshot
    // ------------------------------------------------------------------
const snapshot: PostSnapshot = {
      id:                  fullPost.id,
      title:               fullPost.title,
      authorName:          fullPost.authorName ?? 'unknown',
      subredditName:       fullPost.subredditName ?? 'unknown',
      url:                 fullPost.url ?? '',
      // lightPost (PostV2 proto) exposes flair as .linkFlair?.templateId
      // fullPost  (Post model)   exposes flair as .flair?.templateId
      // Neither has .linkFlairTemplateId - that property does not exist on either type.
      // Use || (not ??) so that an empty-string templateId (text-only flair) is also skipped.
      linkFlairTemplateId: lightPost.linkFlair?.templateId || fullPost.flair?.templateId || '',
    };

    // ------------------------------------------------------------------
    // 3. Idempotency guard - Redis key expires after 30 days
    // ------------------------------------------------------------------
    const guardKey = `autosticky:done:${lightPost.id}`; // Updated
    try {
      const already = await context.redis.get(guardKey);
      if (already) {
        console.log(`[AutoSticky] Post ${lightPost.id} already processed - skipping`); // Updated
        return;
      }
    } catch (err) {
      console.error('[AutoSticky] Redis get error:', err);
      // Don't abort - proceed, worst case is a duplicate comment which Reddit
      // itself will deduplicate if sticky slot is taken.
    }

    // ------------------------------------------------------------------
    // 4. Load settings
    // ------------------------------------------------------------------
    let rulesYaml: string | undefined;
    let catchAllText: string | undefined;
    let catchAllStickied: boolean | undefined;
    let catchAllLocked: boolean | undefined;
    try {
      [rulesYaml, catchAllText, catchAllStickied, catchAllLocked] = await Promise.all([
        context.settings.get<string>('rules'),
        context.settings.get<string>('catch_all_comment'),
        context.settings.get<boolean>('catch_all_stickied'),
        context.settings.get<boolean>('catch_all_locked'),
      ]);
    } catch (err) {
      console.error('[AutoSticky] Could not read settings:', err);
      return;
    }

   // ------------------------------------------------------------------
    // 5. Find a matching rule, then fall back to catch-all
    // ------------------------------------------------------------------
    let commentBody: string | undefined;
    let comment_stickied = true;
    let comment_locked = true;
    let ruleSource: string;

    const hasRules = rulesYaml?.trim();
    const hasCatchAll = catchAllText?.trim();

    if (!hasRules && !hasCatchAll) {
      return;  // Nothing configured - nothing to do
    }

    if (hasRules) {
      const rules = parseRules(rulesYaml!);
      if (rules.length) {
        const matched = matchPost(snapshot, rules);
        if (matched) {
          commentBody    = expandTemplate(matched.comment, snapshot);
          comment_stickied = matched.comment_stickied;
          comment_locked = matched.comment_locked;
          ruleSource     = 'rule match';
        }
      } else {
        console.warn('[AutoSticky] Settings contain no valid rules');
      }
    }

    // No rule matched - try catch-all
    if (!commentBody && hasCatchAll) {
      commentBody      = expandTemplate(catchAllText!, snapshot);
      // Settings default to true; treat undefined (never saved) as true.
      comment_stickied = catchAllStickied !== false;
      comment_locked   = catchAllLocked   !== false;
      ruleSource       = 'catch-all';
    }

    if (!commentBody) return;  // Nothing to post

    console.log(`[AutoSticky] Posting comment on ${fullPost.id} ("${fullPost.title}") via ${ruleSource!}`);

    // ------------------------------------------------------------------
    // 6. Mark as processed BEFORE acting (prevents race conditions)
    // ------------------------------------------------------------------
    try {
      await context.redis.set(guardKey, '1', {
        expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
    } catch (err) {
      console.error('[AutoSticky] Redis set error (non-fatal):', err);
    }

    // ------------------------------------------------------------------
    // 7. Submit the comment
    // ------------------------------------------------------------------
    let comment: Awaited<ReturnType<typeof context.reddit.submitComment>>;
    try {
      comment = await context.reddit.submitComment({
        id:   lightPost.id,  // Devvit adds the t3_ prefix internally
        text: commentBody,
      });
    } catch (err) {
      console.error('[AutoSticky] Failed to submit comment:', err);
      return;
    }

    // ------------------------------------------------------------------
    // 8. Distinguish as mod and (optionally) sticky
    // ------------------------------------------------------------------
    try {
      await comment.distinguish(comment_stickied);
    } catch (err) {
      console.error('[AutoSticky] Failed to distinguish comment:', err);
    }
    // ------------------------------------------------------------------
    // 9. Lock the comment if requested
    // ------------------------------------------------------------------
    if (comment_locked) {
      try {
        await comment.lock();
      } catch (err) {
        console.error('[AutoSticky] Failed to lock comment:', err);
      }
    }

    console.log(
      `[AutoSticky] Done - comment ${comment.id} posted` +
      ` (sticky=${comment_stickied}, locked=${comment_locked}, via=${ruleSource!})`
    );
  },
});

export default Devvit;

// ---------------------------------------------------------------------------
// Help text shown in the settings UI
// ---------------------------------------------------------------------------
const RULES_HELP_TEXT = `\
Write rules in AutoModerator-style YAML. Separate multiple rules with ---.
The FIRST matching rule wins; later rules are skipped.

SUPPORTED CONDITIONS
  title (contains): word            # case-insensitive substring
  title (not-contains): word
  title (starts-with): word
  title (ends-with): word
  title (full-exact): Exact Title
  title [regex]: ^\\[Discussion\\]
  title [not-regex]: pattern
  post_flair_id: abc-123-def        # flair template UUID

  → Multiple values: use a YAML list
      title (contains):
        - help
        - question

  → Multiple conditions on the same rule are ANDed together.

SUPPORTED ACTIONS
  comment: |
    Your sticky comment text here.
    Supports {{author}}, {{subreddit}}, {{title}}, {{url}}.
  comment_stickied: true   # default true - pins comment to thread
  comment_locked: true     # default true - prevents replies

EXAMPLE
---
title (contains):
  - [help]
  - question
comment: |
  Hi u/{{author}}! Looks like you need help.
  Please check the wiki before posting.
comment_stickied: true
comment_locked: true
---
post_flair_id: 9f2a1b3c-xxxx-xxxx-xxxx-000000000000
comment: |
  This flair has special rules. See our sidebar.
comment_stickied: true
comment_locked: false
`;

const CATCH_ALL_HELP_TEXT = `\
Optional. If none of the YAML rules above match a new post, this comment is
posted. Use the toggles below to control whether it is stickied and/or locked.

Leave empty to do nothing when no rules match.

Supports the same template variables as rules:
  {{author}}  {{subreddit}}  {{title}}  {{url}}

Example:
  Thanks for posting, u/{{author}}!
  Please make sure your post follows our community rules.
`;

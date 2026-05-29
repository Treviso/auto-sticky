// ---------------------------------------------------------------------------
// main.ts - Devvit entry point for the AutoSticky app
// ---------------------------------------------------------------------------
// Flow:
//   1. Mod configures rules in the Subreddit Settings page (YAML textarea).
//   2. An optional catch-all Default Comment can be set for posts that match nothing.
//   3. An optional Global Footer is appended to every comment the app posts.
//   4. An optional wiki backup writes all settings to two subreddit wiki pages.
//   5. When a new post is submitted the PostSubmit trigger fires.
//   6. We parse the rules, walk them in order (first-match-wins).
//   7. On a match we post a mod comment and optionally sticky + lock it.
//   8. If NO rule matched but a Default Comment is configured, that fires instead.
//   9. The Global Footer (if any) is appended before submitting.
//  10. A Redis key prevents a second comment if the trigger somehow fires twice.
// ---------------------------------------------------------------------------

import { Devvit, SettingScope } from '@devvit/public-api';
import { parseRules, validateRules, matchPost, expandTemplate } from './rules.js';
import type { PostSnapshot } from './types.js';
import { saveSettingsToWikiPage } from './wiki.js';

// ---------------------------------------------------------------------------
// Devvit capabilities we need
// ---------------------------------------------------------------------------
Devvit.configure({
  redditAPI: true,
  redis:     true,
  scheduler: true,
});

// ---------------------------------------------------------------------------
// Subreddit-scoped settings  (accessible via Mod Tools → App Settings)
// ---------------------------------------------------------------------------
Devvit.addSettings([
  {
    type:     'paragraph',
    name:     'rules',
    label:    'Automated Sticky Comments Rules (YAML)',
    helpText: 'Define rules using YAML. Separate each rule with ---. Supported condition keys: title (contains/starts-with/ends-with/full-exact/[regex]), body (contains/starts-with/ends-with/full-exact/[regex]), post_flair_id.',
    scope:    SettingScope.Subreddit,
    onValidate: async (event, context) => {
      const value = event.value?.trim();
      if (!value) {
        // Blank is valid - schedule a backup so the wiki reflects the cleared field
        await context.scheduler.runJob({
          name: 'saveSettingsToWikiPage',
          runAt: new Date(Date.now() + 5000),
          data: context.userId ? { userId: context.userId } : undefined,
        });
        return;
      }
      try {
        validateRules(value);
      } catch (err) {
        return err instanceof Error ? `Error in rules: ${err.message}` : 'Error in rules';
      }
      await context.scheduler.runJob({
        name: 'saveSettingsToWikiPage',
        runAt: new Date(Date.now() + 5000),
        data: context.userId ? { userId: context.userId } : undefined,
      });
    },
  },
  {
    type:     'paragraph',
    name:     'catch_all_comment',
    label:    'Default Comment (optional)',
    helpText: 'If no rules match, this comment will be posted automatically. Supports Markdown. Leave blank to disable.',
    scope:    SettingScope.Subreddit,
    onValidate: async (_event, context) => {
      await context.scheduler.runJob({
        name: 'saveSettingsToWikiPage',
        runAt: new Date(Date.now() + 5000),
        data: context.userId ? { userId: context.userId } : undefined,
      });
    },
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
  {
    type:         'paragraph',
    name:         'global_footer',
    label:        'Global Footer',
    helpText:     'Text appended to every comment posted by this app, whether from a rule match or the Default Comment. It is recommended that you use this to inform your users that the comment was automated. Supports Markdown. Leave blank to disable.',
    defaultValue: '*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/{{subreddit}}) if you have any questions or concerns.*',
    scope:        SettingScope.Subreddit,
    onValidate: async (_event, context) => {
      await context.scheduler.runJob({
        name: 'saveSettingsToWikiPage',
        runAt: new Date(Date.now() + 5000),
        data: context.userId ? { userId: context.userId } : undefined,
      });
    },
  },
  {
    type:         'boolean',
    name:         'backup_to_wiki',
    label:        'Backup settings to wiki pages',
    helpText:     "Backs up YAML rules to the wiki page 'auto-sticky-rules' and all other settings to 'auto-sticky-config'. Both pages are visible to subreddit mods only. The backups are updated whenever the YAML rules, Default Comment, or Global Footer fields are saved. Visit https://old.reddit/r/SUBREDDITNAME/wiki/auto-sticky-config if you already migrated to the new wiki.",
    defaultValue: false,
    scope:        SettingScope.Subreddit,
  },
]);

// ---------------------------------------------------------------------------
// Scheduled job - wiki backup
// ---------------------------------------------------------------------------
Devvit.addSchedulerJob({
  name: 'saveSettingsToWikiPage',
  onRun: saveSettingsToWikiPage,
});

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
    let fullPost: Awaited<ReturnType<typeof context.reddit.getPostById>>;
    try {
      fullPost = await context.reddit.getPostById(lightPost.id);
    } catch (err) {
      console.error('[AutoSticky] Failed to fetch post:', err);
      return;
    }

    // ------------------------------------------------------------------
    // 2. Build post snapshot
    // ------------------------------------------------------------------
    const snapshot: PostSnapshot = {
      id:                  fullPost.id,
      title:               fullPost.title,
      body:                fullPost.body ?? '',
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
    const guardKey = `autosticky:done:${lightPost.id}`;
    try {
      const already = await context.redis.get(guardKey);
      if (already) {
        console.log(`[AutoSticky] Post ${lightPost.id} already processed - skipping`);
        return;
      }
    } catch (err) {
      console.error('[AutoSticky] Redis get error:', err);
      // Don't abort - proceed, worst case is a duplicate comment
      // which Reddit itself should deduplicate if sticky slot is taken.
    }

    // ------------------------------------------------------------------
    // 4. Load settings
    // ------------------------------------------------------------------
    let rulesYaml: string | undefined;
    let catchAllText: string | undefined;
    let catchAllStickied: boolean | undefined;
    let catchAllLocked: boolean | undefined;
    let globalFooter: string | undefined;
    try {
      [rulesYaml, catchAllText, catchAllStickied, catchAllLocked, globalFooter] = await Promise.all([
        context.settings.get<string>('rules'),
        context.settings.get<string>('catch_all_comment'),
        context.settings.get<boolean>('catch_all_stickied'),
        context.settings.get<boolean>('catch_all_locked'),
        context.settings.get<string>('global_footer'),
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
    let ruleSource = 'unknown';

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

    // Append the global footer (if configured) to every comment
    const footerText = globalFooter?.trim()
      ? expandTemplate(globalFooter.trim(), snapshot)
      : undefined;
    if (footerText) {
      commentBody += `\n\n${footerText}`;
    }

    console.log(`[AutoSticky] Posting comment on ${fullPost.id} ("${fullPost.title}") via ${ruleSource}`);

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
      ` (sticky=${comment_stickied}, locked=${comment_locked}, via=${ruleSource})`
    );
  },
});

export default Devvit;

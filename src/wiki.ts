// ---------------------------------------------------------------------------
// wiki.ts - Backup app settings to a subreddit wiki page
// ---------------------------------------------------------------------------
// Triggered via a scheduled job scheduled from the onValidate hooks of every
// paragraph setting (rules, catch_all_comment, global_footer).  Boolean
// settings (catch_all_stickied, catch_all_locked) do not support onValidate
// and are not independently able to trigger a backup, but their current
// values are included in every backup written by the paragraph fields.
// ---------------------------------------------------------------------------

import {
  JSONObject,
  ScheduledJobEvent,
  TriggerContext,
  User,
  WikiPage,
  WikiPagePermissionLevel,
} from '@devvit/public-api';

export const RULES_WIKI_PAGE = 'auto-sticky-rules';
export const CONFIG_WIKI_PAGE = 'auto-sticky-config';

// ---------------------------------------------------------------------------
// Scheduled-job handler  (registered in main.ts)
// ---------------------------------------------------------------------------
export async function saveSettingsToWikiPage(
  event: ScheduledJobEvent<JSONObject | undefined>,
  context: TriggerContext,
): Promise<void> {
  // Check the feature toggle first - bail early if it's off
  const backupEnabled = await context.settings.get<boolean>('backup_to_wiki');

  if (!backupEnabled) {
    return;
  }

  // Read every setting that we want to preserve
  const [
    rulesYaml,
    catchAllComment,
    catchAllStickied,
    catchAllLocked,
    globalFooter,
  ] = await Promise.all([
    context.settings.get<string>('rules'),
    context.settings.get<string>('catch_all_comment'),
    context.settings.get<boolean>('catch_all_stickied'),
    context.settings.get<boolean>('catch_all_locked'),
    context.settings.get<string>('global_footer'),
  ]);

  const subreddit = await context.reddit.getCurrentSubreddit();
  // Build the wiki pages content
 
  const rulesContent = buildRulesWikiContent(rulesYaml);

  const configContent = buildConfigWikiContent({
    subreddit: subreddit.name,
    catchAllComment,
    catchAllStickied,
    catchAllLocked,
    globalFooter,
  });


  let reason: string | undefined;

  const userId = event.data?.userId as string | undefined;

  if (userId) {
    try {
      const user: User = await context.reddit.getUserById(userId);
      reason = `Settings updated by /u/${user.username}`;
    } catch {
      // Ignore lookup failures
    }
  }

  await upsertWikiPage({
    context,
    subredditName: subreddit.name,
    page: RULES_WIKI_PAGE,
    content: rulesContent,
    reason,
  });

  await upsertWikiPage({
    context,
    subredditName: subreddit.name,
    page: CONFIG_WIKI_PAGE,
    content: configContent,
    reason,
  });
}

async function upsertWikiPage(options: {
  context: TriggerContext;
  subredditName: string;
  page: string;
  content: string;
  reason?: string;
}): Promise<void> {
  const {
    context,
    subredditName,
    page,
    content,
    reason,
  } = options;

  let existingPage: WikiPage | undefined;

  try {
    existingPage = await context.reddit.getWikiPage(
      subredditName,
      page,
    );
  } catch {
    // Page does not exist yet
  }

  // Skip unnecessary writes
  if (existingPage?.content.trim() === content.trim()) {
    return;
  }

  const updateOptions = {
    subredditName,
    page,
    content,
    reason,
  };

  if (existingPage) {
    await context.reddit.updateWikiPage(updateOptions);
  } else {
    await context.reddit.createWikiPage(updateOptions);

    await context.reddit.updateWikiPageSettings({
      subredditName,
      page,
      listed: true,
      permLevel: WikiPagePermissionLevel.MODS_ONLY,
    });
  }
}

function buildRulesWikiContent(
  rulesYaml: string | undefined,
): string {
  return rulesYaml?.trim() || '';
}

interface ConfigSnapshot {
  subreddit: string;
  catchAllComment: string | undefined;
  catchAllStickied: boolean | undefined;
  catchAllLocked: boolean | undefined;
  globalFooter: string | undefined;
}

function buildConfigWikiContent(
  snapshot: ConfigSnapshot,
): string {
  function indentCodeBlock(content: string): string {
    return content
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
  }

  const lines: string[] = [];

  lines.push('# Automated Sticky Comments Configuration');
  lines.push('');

  lines.push(
    `- YAML Rules backup: https://old.reddit.com/r/${snapshot.subreddit}/wiki/${RULES_WIKI_PAGE}`,
  );

  lines.push(
    `- App settings: https://developers.reddit.com/r/${snapshot.subreddit}/apps/auto-sticky`,
  );

  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Default Comment');
  lines.push('');

  if (snapshot.catchAllComment?.trim()) {
    lines.push(indentCodeBlock(snapshot.catchAllComment.trim()));
  } else {
    lines.push('*(not configured)*');
  }

  lines.push('');

  lines.push(
    `**Sticky Default Comment:** ${
      snapshot.catchAllStickied !== false ? 'Yes' : 'No'
    }`,
  );

  lines.push('');

  lines.push(
    `**Lock Default Comment:** ${
      snapshot.catchAllLocked !== false ? 'Yes' : 'No'
    }`,
  );

  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Global Footer');
  lines.push('');

  if (snapshot.globalFooter?.trim()) {
    lines.push(indentCodeBlock(snapshot.globalFooter.trim()));
  } else {
    lines.push('*(not configured)*');
  }

  lines.push('');

  return lines.join('\n');
}
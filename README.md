# Automated Sticky Comments

Automated Sticky Comments is a moderation tool that automatically posts a **stickied, locked mod comment** on new posts based on their **title**, **body text** and/or **post flair**, using a syntax almost identical to u/AutoModerator. It also features an optional fallback **Default Comment** for posts that do not match any rule, an optional **Global Footer** appended to every comment the app posts, and an optional **backup of all settings to your subreddit wiki**.

---

## Why use this instead of AutoModerator?

While AutoModerator is powerful, it has specific limitations when it comes to reliably posting sticky comments. This app is purpose-built to address them.

### Sticky comments are always expanded

Stickied comments posted by AutoModerator are **collapsed by default** - users see a small bar with the username and have to manually click to expand it. Comments posted by this app are **always fully expanded**, making your message immediately visible without any action required from the reader.

### Sticky comments post reliably, even when AutoModerator removes the post

AutoModerator processes all rules top-to-bottom and **stops as soon as a rule takes a moderation action**. This means if a removal or filter rule matches first, any rule intended to post a sticky comment will never run.

This app runs **independently** of AutoModerator. It listens for new post events directly and is not affected by AutoModerator's rule ordering or actions. A post being removed by AutoModerator does not prevent this app from posting its comment. Double-Post protection also prevents the app from triggering on the same post twice.

### Full Unicode and emoji support

AutoModerator requires emoji to be written as HTML entities in comment text (e.g. `&#128512;` instead of 😀). This app accepts **emoji and Unicode characters directly**, both in comment bodies and in regex patterns. Unicode property escapes such as `\p{Letter}` also work in regex conditions, which AutoModerator does not support at all.

---

## Configuration Settings

If you are migrating rules from your AutoModerator config, please also check out the Differences from AutoModerator section.

The app features the following settings in your Subreddit App Settings panel:

### ⚙️ Automated Sticky Comments Rules (YAML)

* **Description:** A text area where you write specific matching rules using AutoModerator-style YAML formatting.
* **Behaviour:** Rules are separated by `---`. The app checks these rules sequentially from top to bottom (**first-match-wins**). As soon as a post meets all conditions of a rule, its corresponding comment is posted and all subsequent rules are skipped.

### ⚙️ Default Comment (optional)

* **Description:** A fallback comment posted when an incoming post doesn't satisfy any of your active YAML rules.
* **Behaviour:** If the YAML rules field is empty, or if a post fails to match *any* rule, this Default Comment is posted instead. Leave this field completely empty if you do not want any fallback comment. Supports markdown and template variables such as (`{{author}}`, `{{subreddit}}`, `{{title}}`, `{{url}}`). 

* **Sticky Default Comment** *(toggle, default: on)* - pins the Default Comment as a stickied mod comment.
* **Lock Default Comment** *(toggle, default: on)* - disables replies to the Default Comment.

### ⚙️ Global Footer (optional)

* **Description:** A paragraph (or string) of text appended to the bottom of **every** comment the app posts, whether from a matched rule or the Default Comment.
* **Behaviour:** The footer is added after a blank line, separated from the main comment body. It supports markdown and the same template variables as the Default Comment. By default, the field is pre-filled with a bot disclosure message identical to AutoModerator. Leave this field completely empty to disable the footer entirely.

### ⚙️ Backup settings to wiki pages (optional, default: off)

* **Description:** When enabled, saves a backup of all app settings to two subreddit wiki pages: `auto-sticky-rules` (containing your raw YAML rules) and `auto-sticky-config` (containing your Default Comment, its sticky/lock toggles, and your Global Footer). Both pages are set to mods-only visibility when first created.
* **Behaviour:** Backups are written automatically whenever the **YAML rules**, **Default Comment**, or **Global Footer** fields are saved. The sticky/lock toggles for the Default Comment do not trigger a backup on their own, but their current values are always included in the next backup triggered by any of the paragraph fields above. This setting itself is not backed up to the wiki.

---

## How it Evaluates New Posts

When a user submits a new post, the app processes it through a strict step-by-step order:

1. **Double-Post Protection (Idempotency):** The app immediately checks if it has already processed this exact post. If Reddit delivers the `onPostSubmit` event more than once (or if a glitch retries the event), the app remembers the post ID and will safely ignore the duplicate, ensuring your users never see double bot comments.
2. **Sequential Rule Check:** The app reads your YAML rules from top to bottom. If a post meets every condition in a rule, it posts that rule's comment and stops checking further rules.
3. **Fallback to Default:** If the post does not match any rule, or if no YAML rules have been written, the app falls back to your Default Comment. If that field is also empty, the app ends without posting anything.
4. **Global Footer:** If a Global Footer is configured, it is automatically appended to whichever comment is posted - rule match or Default Comment. If the app posts nothing (no match and no Default Comment), the footer is not appended (as no comment is posted).

---

## Rule YAML Reference

### Conditions

All conditions within a single rule block must be true (**AND** semantics). If you provide multiple text values inside a single condition, matching *any* one of them is enough to satisfy that condition (**OR** semantics). A complete settings example is provided in the last section of this readme.

#### Title Checks

```yaml
title (contains): keyword               # single value
title (contains): [keyword, other]      # inline list - any one matches
title (contains): ["need help, urgent", "getting started"]
                                        # inline list - matches strings inside quotes

title (contains):                       # block list - any one matches
  - keyword one
  - keyword two

title (not-contains): unwanted
title (starts-with): "[Help]"
title (ends-with): "?"
title (full-exact): Exact Post Title Here
title [regex]: '^\[Discussion\]'        # positive match - must match
title [not-regex]: '\bNSFW\b'           # negative match - must not match
```
```yaml
title (regex): '^\[Discussion\]'  # valid positive match alternative (round brackets)
title (not-regex): '\bNSFW\b'     # valid negative match alternative (round brackets)
```

#### Body Checks

Body checks work identically to title checks but match against the **self-text body** of a post. 
Body and title conditions can be freely combined within a single rule.

```yaml
body (contains): keyword               # single value
body (contains): [keyword, other]      # inline list - any one matches
body (contains): ["need help, urgent", "getting started"]
                                       # inline list - matches strings inside quotes

body (contains):                       # block list - any one matches
  - keyword one
  - keyword two

body (not-contains): unwanted
body (starts-with): "Thanks for"
body (ends-with): "?"
body (full-exact): Exact body text here
body [regex]: '^\[Context\]'           # positive match - must match
body [not-regex]: '\bspam\b'           # negative match - must not match
```
```yaml
body (regex): '^\[Context\]'  # valid positive match alternative (round brackets)
body (not-regex): '\bspam\b'  # valid negative match alternative (round brackets)
```

*Note: Title and body text matching is always **case-insensitive**.*

*Note: The combined `title+body` AutoModerator syntax is not supported. Placing a `title` condition and a `body` condition in the same rule requires **both** to pass (AND).  
To match a value in either field, write two separate rules with the same comment.*

#### Post Flair Checks

```yaml
post_flair_id: 9f2a1b3c-0000-0000-0000-aabbccddeeff         # single ID
post_flair_id: [9f2a1b3c-..., deadbeef-...]                 # inline list
post_flair_id:                                              # block list
  - 9f2a1b3c-0000-0000-0000-aabbccddeeff
  - deadbeef-0000-0000-0000-112233445566
```

---

### Actions

```yaml
comment: |
  Your comment text here.
  Markdown is supported.
  Template variables: {{author}}  {{subreddit}}  {{title}}  {{url}}

comment_stickied: true    # default: true  - pins as stickied mod comment
comment_locked: true      # default: true  - disables replies from non-mods
```

*Note: All comments created by this app are automatically distinguished as a **Moderator** (green shield).*

---

## Differences from AutoModerator

This section is specifically for moderators migrating existing AutoModerator rules. The YAML syntax is intentionally close to AutoModerator's, but there are important differences to be aware of. The app supports YAML data validation and will throw errors if your code is incompatible.

### This app only handles a subset of AutoModerator conditions

AutoModerator can match on many fields: author name, author flair, domain, URL, post type, karma thresholds, account age, and more. **This app currently only supports:**

- `title` conditions (`contains`, `not-contains`, `starts-with`, `ends-with`, `full-exact`, `[regex]`, `[not-regex]`)
- `body` conditions (`contains`, `not-contains`, `starts-with`, `ends-with`, `full-exact`, `[regex]`, `[not-regex]`)
- `post_flair_id`

The combined `title+body` AutoModerator syntax is not supported.

Any other AutoModerator condition keys will be silently ignored. Always check that your copied rule only relies on supported fields.

### This app only posts comments - it can't send DMs/chat requests or take any other actions

AutoModerator can approve, remove, filter, report, and ban. This app **only posts a comment**. The `action`, `action_reason`, `set_locked`, and similar AutoModerator action keys are not recognised and will be ignored.

### `comment_stickied` and `comment_locked` default to `true`

In AutoModerator, a `comment:` action posts a regular, non-stickied, unlocked comment unless you explicitly configure otherwise. In this app, **both default to `true`**. If you copy a rule from AutoModerator that posts a comment without those fields set, the result here will be stickied and locked - which may or may not be what you want. Always set them explicitly if you have a preference:

```yaml
comment_stickied: false
comment_locked: false
```

### Regex uses JavaScript syntax, not Python

AutoModerator uses Python's `re` module. This app uses JavaScript's `RegExp` engine. The two are highly compatible for everyday patterns, but the following differences can catch you out when copying AutoModerator regex rules:

| Feature | AutoModerator (Python) | This app (JavaScript) |
|---|---|---|
| Named capture groups | `(?P<name>...)` | `(?<name>...)` |
| End-of-string anchor | `\Z` | `$` |
| Possessive quantifiers | `a++`, `a*+` | Not supported |
| Atomic groups | `(?>...)` | Not supported |
| Unicode property escapes | Not supported | `\p{Letter}`, `\p{Emoji}` etc. work |

																																																																																										



The most likely issue when copying from AutoModerator is **named capture groups**: `(?P<name>...)` is Python-only syntax and will cause the pattern to fail to compile in JavaScript. Rewrite them as `(?<name>...)` or as non-capturing groups `(?:...)` if the name isn't needed. Error validation should make it possible to pinpoint any incompatibilities.

---


## Complete Settings Example

#### 1. "Automated Sticky Comments Rules (YAML)" field:

```yaml
# Rule 1 - sticky message for help/question posts (title check)
title (contains): [help, question]
comment: |
  Hi u/{{author}}, it looks like you're asking for help!

  Before we dig in, please make sure you've checked our subreddit wiki.
  If you have questions about this, please [contact our mods via modmail](https://www.reddit.com/message/compose?to=/r/{{subreddit}}) rather than replying here. Thank you!
comment_stickied: true
comment_locked: true
---
# Rule 2 - body text check: posts mentioning a resolved state
body (contains): [TL;DR, solved, "fixed it"]
comment: |
  It looks like your post may already be resolved, u/{{author}}!

  If your issue is sorted, please update your post flair to **Solved** so other members know.
comment_stickied: true
comment_locked: false
---
# Rule 3 - combined title and body check: detailed questions
title (ends-with): "?"
body (not-contains): [screenshot, image, photo]
comment: |
  Thanks for your detailed question, u/{{author}}!

  Our community will do its best to help. In the meantime, check the **[wiki](https://www.reddit.com/r/{{subreddit}}/wiki)** - your answer might already be there.
comment_stickied: true
comment_locked: false
---
# Rule 4 - flair-specific announcement
post_flair_id: 9f2a1b3c-xxxx-xxxx-xxxx-000000000000
comment: |
  **Posts carrying this flair are subject to strict community rules.**
comment_stickied: true
comment_locked: false
---
# Rule 5 - flair-specific + title match
title (contains): ["[SPOILERS]", "[SPOILER]"]
post_flair_id: 9f2a1b3c-xxxx-xxxx-xxxx-000000000000
comment: |
  **This post was tagged for spoilers.**
comment_stickied: true
comment_locked: false

```

#### 2. "Default Comment" field:

```text
Thanks for posting to r/{{subreddit}}, u/{{author}}!

Please ensure your post aligns with our general guidelines.
```

#### 3. "Global Footer" field:

```text
*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/{{subreddit}}) if you have any questions or concerns.*
```

The Global Footer is appended after a blank line to every comment the app posts. In the example above, a matched rule comment would be sent as:

```text
Thanks for your detailed question, u/ExampleUser!

Our community will do its best to help. In the meantime, check the **wiki** - your answer might already be there.

*I am a bot, and this action was performed automatically. Please contact the moderators of this subreddit if you have any questions or concerns.*
```

---

## Changelog

#### v1.1: YAML validation error messages, body text checks, Global Footer, Backup to Wiki

#### v1.0: Initial release

---

## Planned functionality (no ETA)

- Author checks - `username`, `is_contributor`/ `contributors_exempt`, `is_moderator`/ `moderators_exempt`

- Support for `case-sensitive` - optional case-sensitive modifier

- `url` and `domain` checks for link submissions, post type checks

- AND matching for multiple types of checks (e.g. `body+title`)

- Alternate post flair checks

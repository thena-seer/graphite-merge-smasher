# Graphite Merge Smasher

A Chrome extension that babysits a Graphite PR through the merge queue so you don't have to.

Graphite has a longstanding bug where a PR silently drops out of the merge queue for no stated
reason. The usual fix is to notice, sigh, and click "Merge" → "Add to queue" again. This extension
does the noticing and the re-clicking for you: activate it on a PR page and it will keep putting the
PR back in the queue until the PR actually merges.

## How it works

Once activated on a Graphite PR page, the extension runs this loop:

1. Click **Merge**.
2. Click **Add to queue** in the menu that opens.
3. Wait, then reload the page. Give it 5 seconds to hydrate and read the PR's current state.
4. Branch on what it finds:
   - **Merged** → stop, and report success.
   - **Still queued / merging** → keep waiting; go back to step 3.
   - **"Ready to merge"**, or the banner *"This pull request was removed from the merge queue due to
     unexpected error"* → the Graphite bug struck. Go back to step 1 and merge it all over again.
   - **Blocked** (conflict, failing checks, closed) → stop and leave it alone.

PR state is read from Graphite's action card — the `<article data-kind="...">` whose heading says
"Ready to merge", "Merged", and so on. Its CSS-module class names carry a build hash that changes
between Graphite deploys, so the selectors match on the stable substring (`prActionCardTitle`) and on
heading text rather than on a full class name.

Because step 3 reloads the page, the extension's state cannot live in a page variable — it is
persisted (keyed by PR URL) so the content script can pick the loop back up after each reload. The
loop is bound to a single PR: activating on one PR does not affect any other tab.

Timings and limits live in the `CONFIG` object at the top of `content.js`: 5s post-reload settle, 30s
between refreshes, 15s to find a button, 10 re-queue attempts, 2h overall stop.

## Activation

Click the extension's toolbar icon while on a Graphite PR page to arm the loop for that PR. Click it
again to disarm. The extension takes no action on a page until it has been explicitly armed — it
never merges anything on its own.

The toolbar badge tracks the loop: `...` (blue) while working, `OK` (green) once merged, `!` (red) if
it stopped early. Every decision is also logged to the page console under `[merge-smasher]`.

## Safety rails

- **Explicit opt-in per PR.** No page is touched until you activate it on that specific PR.
- **Bounded retries.** The re-merge cycle gives up after a configured number of attempts rather than
  looping forever, so a permanently un-mergeable PR doesn't get hammered indefinitely.
- **Polite polling.** Refreshes are spaced out on an interval, not spun as fast as the page loads.
- **Stops on anything unexpected.** If the page doesn't look like a PR page, the buttons can't be
  found, or the PR shows a hard failure (merge conflict, failing required checks, closed), the loop
  disarms and leaves the PR alone.

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" using the toggle in the top right
3. Click "Load unpacked" and select the folder containing this extension
4. Pin the extension so its toolbar icon is visible

## Usage

1. Navigate to a Graphite PR page (e.g. `app.graphite.dev/github/pr/...`)
2. Click the extension icon to arm the merge loop for that PR
3. Leave the tab open — it will refresh itself periodically
4. The loop ends when the PR merges, when retries are exhausted, or when you disarm it

## Files

- `manifest.json` - Extension configuration
- `background.js` - Service worker; relays the toolbar click to the PR tab
- `content.js` - Content script that drives the buttons and reads PR state
- `README.md` - This file

## Playing nicely with Merge on a Friday

The [Merge on a Friday](https://github.com/thena-seer/merge-on-a-friday) extension rewrites the same
buttons this one clicks, turning "Merge" into "Merge on a Friday" and "Add to queue" into "Add to
queue (on a Friday)". Button lookups here strip that suffix before matching, so the two can be
installed side by side. Only the button text is affected — the action card headings this extension
reads for PR state are left alone by the Friday extension.

## Scope

Graphite only (`app.graphite.dev`, `app.graphite.com`). GitHub's own merge UI is not automated.

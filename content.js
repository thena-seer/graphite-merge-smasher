// Graphite Merge Smasher content script.
//
// Arming is per-PR and survives page reloads, because the merge loop refreshes
// the page as part of its polling cycle: every reload re-runs this script from
// scratch, so the loop's state has to be read back out of chrome.storage.local
// rather than held in a variable here.

const CONFIG = {
  // How long to let the page hydrate after a reload before reading its state.
  settleMs: 5000,
  // Gap between refreshes while the PR is sitting in the queue.
  pollIntervalMs: 60000,
  // How long to wait for a button to show up before giving up on a click.
  buttonWaitMs: 15000,
  // Re-queue this many times before concluding it is never going to take.
  maxRequeueAttempts: 10,
  // Overall wall-clock stop, in case the PR parks in the queue forever.
  maxTotalMs: 2 * 60 * 60 * 1000,
};

const TEXT = {
  readyToMerge: "ready to merge",
  dequeueError:
    "This pull request was removed from the merge queue due to unexpected error",
  // Tried in order; Graphite labels this differently depending on PR state.
  mergeButtons: ["merge when ready", "merge"],
  addToQueue: "add to queue",
};

const STORAGE_PREFIX = "smasher:";

let pendingTimer = null;

// ---------------------------------------------------------------- persistence

// Graphite PR URLs look like /github/pr/<org>/<repo>/<number>/<slug>; the slug
// changes when the PR title changes, so key on everything up to the number.
function prKey() {
  const match = location.pathname.match(/^\/github\/pr\/[^/]+\/[^/]+\/\d+/);
  return match ? STORAGE_PREFIX + match[0] : null;
}

async function getState(key) {
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

async function setState(key, state) {
  await chrome.storage.local.set({ [key]: state });
}

async function clearState(key) {
  await chrome.storage.local.remove(key);
}

// ------------------------------------------------------------------- plumbing

function log(...args) {
  console.log("[merge-smasher]", ...args);
}

function setBadge(text, color) {
  chrome.runtime.sendMessage({ type: "status", text, color }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => {
    pendingTimer = setTimeout(resolve, ms);
  });
}

function cancelPending() {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

// Poll a lookup until it returns something truthy, or the timeout expires.
async function waitFor(lookup, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = lookup();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

// --------------------------------------------------------------- reading state

// The PR action card is Graphite's summary of what the PR is waiting on. Class
// names are CSS-module hashes that change between deploys, so match on the
// stable part of the name.
function actionCardTitle() {
  const el = document.querySelector('[class*="prActionCardTitle"]');
  return el ? el.textContent.trim().toLowerCase() : null;
}

function pageText() {
  return document.body.innerText || "";
}

// One of: merged | ready | dequeued | queued | blocked | unknown
function classifyPr() {
  // Check the dequeue bug first: the card can still read "ready to merge" while
  // the error banner explains why, and the two want different attempt counting.
  if (pageText().includes(TEXT.dequeueError)) return "dequeued";

  const title = actionCardTitle();
  if (!title) return "unknown";

  if (title.includes("merged")) return "merged";
  if (title.includes(TEXT.readyToMerge)) return "ready";
  if (title.includes("queue") || title.includes("merging")) return "queued";

  const card = document.querySelector("article[data-kind]");
  if (card && card.dataset.kind === "negative") return "blocked";

  return "unknown";
}

// -------------------------------------------------------------- finding buttons

function isVisible(el) {
  if (el.getAttribute("aria-disabled") === "true" || el.disabled) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// The Merge on a Friday extension rewrites these same buttons in place --
// "Merge" becomes "Merge on a Friday", "Add to queue" becomes "Add to queue
// (on a Friday)". Strip that suffix so both extensions can run together.
const FRIDAY_SUFFIX = /\s*\(?on a friday\)?$/;

function normalizedText(el) {
  return (el.textContent || "")
    .trim()
    .toLowerCase()
    .replace(FRIDAY_SUFFIX, "");
}

// Graphite renders most of these as real <button>s, but some as plain divs, so
// fall back to any leaf element whose entire text is the label we want.
function findByText(labels) {
  const clickable = Array.from(
    document.querySelectorAll('button, [role="button"], a[role="button"]'),
  ).filter(isVisible);

  for (const label of labels) {
    const hit = clickable.find((el) => normalizedText(el) === label);
    if (hit) return hit;
  }

  for (const label of labels) {
    const leaf = Array.from(document.querySelectorAll("div, span")).find(
      (el) =>
        el.childElementCount === 0 && normalizedText(el) === label && isVisible(el),
    );
    if (leaf) return leaf;
  }

  return null;
}

// ----------------------------------------------------------------- the loop

async function stop(key, reason, badge = "!", color = "#b91c1c") {
  cancelPending();
  await clearState(key);
  log("stopped:", reason);
  setBadge(badge, color);
}

function scheduleReload(state, key, delayMs) {
  cancelPending();
  pendingTimer = setTimeout(async () => {
    // Re-read before reloading: the user may have disarmed while we waited.
    if (!(await getState(key))) return;
    log("refreshing");
    location.reload();
  }, delayMs);
}

// Click Merge, then Add to queue in whatever menu or dialog that opens.
async function requeue(key, state) {
  if (state.attempts >= CONFIG.maxRequeueAttempts) {
    return stop(key, `gave up after ${state.attempts} attempts`);
  }

  state.attempts += 1;
  state.phase = "merging";
  await setState(key, state);
  log(`merge attempt ${state.attempts}/${CONFIG.maxRequeueAttempts}`);

  const mergeButton = await waitFor(
    () => findByText(TEXT.mergeButtons),
    CONFIG.buttonWaitMs,
  );
  if (!mergeButton) return stop(key, "no Merge button on the page");
  mergeButton.click();

  const queueButton = await waitFor(
    () => findByText([TEXT.addToQueue]),
    CONFIG.buttonWaitMs,
  );
  if (!queueButton) return stop(key, "Merge did not open an Add to queue option");
  queueButton.click();
  log("added to queue");

  state.phase = "waiting";
  await setState(key, state);
  setBadge("...", "#2563eb");
  scheduleReload(state, key, CONFIG.pollIntervalMs);
}

// Read the PR's state once and decide what to do about it.
async function step(key) {
  const state = await getState(key);
  if (!state) return;

  if (Date.now() - state.startedAt > CONFIG.maxTotalMs) {
    return stop(key, "hit the overall time limit");
  }

  const status = classifyPr();
  log("state:", status);

  switch (status) {
    case "merged":
      return stop(key, "merged", "OK", "#15803d");

    case "ready":
      // Either we just armed, or the PR fell out of the queue quietly.
      return requeue(key, state);

    case "dequeued":
      log("hit the Graphite dequeue bug, merging again");
      return requeue(key, state);

    case "queued":
      setBadge("...", "#2563eb");
      return scheduleReload(state, key, CONFIG.pollIntervalMs);

    case "blocked":
      return stop(key, "PR is blocked (conflict, failing checks, or closed)");

    default:
      return stop(key, "could not read the PR's state");
  }
}

// ------------------------------------------------------------------- entry points

async function toggleArmed() {
  const key = prKey();
  if (!key) {
    log("not a Graphite PR page, ignoring");
    return;
  }

  if (await getState(key)) {
    cancelPending();
    await clearState(key);
    log("disarmed", key);
    setBadge("", "#2563eb");
    return;
  }

  await setState(key, { phase: "waiting", attempts: 0, startedAt: Date.now() });
  log("armed", key);
  setBadge("...", "#2563eb");
  await step(key);
}

async function resumeIfArmed() {
  const key = prKey();
  if (!key) return;

  const state = await getState(key);
  if (!state) return;

  log("resuming after reload", state);
  setBadge("...", "#2563eb");
  // Give the page time to hydrate; the action card is not in the initial HTML.
  await sleep(CONFIG.settleMs);
  if (await getState(key)) await step(key);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "toggle-armed") toggleArmed();
});

resumeIfArmed();

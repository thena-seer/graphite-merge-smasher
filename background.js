// Relays toolbar clicks to the content script running on the PR tab, and
// paints that tab's badge with whatever the content script reports back.
// The content script owns the merge loop and its persisted state; this worker
// holds nothing of its own.

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggle-armed" }).catch(() => {
    // No content script on this tab (not a Graphite page, or not loaded yet).
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "status" || !sender.tab?.id) return;

  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: message.text });
  if (message.text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: message.color });
  }
});

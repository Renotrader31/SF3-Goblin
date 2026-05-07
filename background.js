function isSupportedUrl(url) {
  return typeof url === "string" && (
    url.startsWith("https://app.bigshort.com/") ||
    url.startsWith("file://")
  );
}

async function ensureContentScript(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!message.includes("Cannot access") && !message.includes("No tab with id")) {
      console.warn("[SF3 Live Monitor] Failed to inject content script:", message);
    }
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (error) {
      console.warn("[SF3 Live Monitor] Failed to open side panel:", String(error?.message || error || ""));
    }
  }

  if (tab?.id && isSupportedUrl(tab.url)) {
    void ensureContentScript(tab.id);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isSupportedUrl(tab?.url)) {
    return;
  }

  void ensureContentScript(tabId);
});
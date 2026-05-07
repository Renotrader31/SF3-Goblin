const SNAPSHOT_STORAGE_KEY = "sf3LiveMonitorSnapshot";
const MONITOR_TARGET_STORAGE_KEY = "sf3LiveMonitorTarget";

function isSupportedUrl(url) {
  return typeof url === "string" && (
    url.startsWith("https://app.bigshort.com/") ||
    url.startsWith("file://")
  );
}

async function getMonitorTarget() {
  const data = await chrome.storage.local.get(MONITOR_TARGET_STORAGE_KEY);
  return data[MONITOR_TARGET_STORAGE_KEY] || null;
}

async function clearStoredSnapshot() {
  await chrome.storage.local.remove(SNAPSHOT_STORAGE_KEY);
}

async function saveMonitorTarget(target) {
  await chrome.storage.local.set({
    [MONITOR_TARGET_STORAGE_KEY]: target
  });
  return target;
}

async function setMonitorTarget(tab) {
  if (!tab?.id || !isSupportedUrl(tab.url)) {
    return null;
  }

  await clearStoredSnapshot();

  return saveMonitorTarget({
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    url: tab.url || "",
    title: tab.title || "",
    status: "active",
    pinnedAt: new Date().toISOString()
  });
}

async function updateMonitorTargetForTab(tabId, tab, status) {
  const target = await getMonitorTarget();
  if (!target || target.tabId !== tabId) {
    return null;
  }

  return saveMonitorTarget({
    ...target,
    windowId: tab?.windowId ?? target.windowId ?? null,
    url: tab?.url || target.url || "",
    title: tab?.title || target.title || "",
    status,
    lastUpdatedAt: new Date().toISOString()
  });
}

async function markMonitorTargetClosed(tabId) {
  const target = await getMonitorTarget();
  if (!target || target.tabId !== tabId) {
    return;
  }

  await clearStoredSnapshot();

  await saveMonitorTarget({
    ...target,
    tabId: null,
    windowId: null,
    status: "closed",
    closedAt: new Date().toISOString()
  });
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

async function requestImmediateScan(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "sf3-live-monitor-force-scan"
    });
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!message.includes("Receiving end does not exist") && !message.includes("No tab with id")) {
      console.warn("[SF3 Live Monitor] Failed to request a scan:", message);
    }
  }
}

async function handleSnapshotPublish(message, sender) {
  const senderTabId = sender.tab?.id;
  const target = await getMonitorTarget();

  if (!senderTabId || !target?.tabId || senderTabId !== target.tabId) {
    return { accepted: false, reason: "not-target" };
  }

  await chrome.storage.local.set({
    [SNAPSHOT_STORAGE_KEY]: {
      ...message.snapshot,
      monitorTarget: {
        tabId: target.tabId,
        windowId: target.windowId,
        url: target.url,
        title: target.title,
        status: target.status,
        pinnedAt: target.pinnedAt
      }
    }
  });

  return { accepted: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "sf3-live-monitor-publish-snapshot") {
    return undefined;
  }

  void handleSnapshotPublish(message, sender)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      console.warn("[SF3 Live Monitor] Failed to handle snapshot publish:", String(error?.message || error || ""));
      sendResponse({ accepted: false, reason: "error" });
    });

  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (error) {
      console.warn("[SF3 Live Monitor] Failed to open side panel:", String(error?.message || error || ""));
    }
  }

  if (tab?.id && isSupportedUrl(tab.url)) {
    void setMonitorTarget(tab)
      .then(() => ensureContentScript(tab.id))
      .then(() => requestImmediateScan(tab.id));
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  if (isSupportedUrl(tab?.url)) {
    void ensureContentScript(tabId);
  }

  void getMonitorTarget().then((target) => {
    if (target?.tabId !== tabId) {
      return;
    }

    if (isSupportedUrl(tab?.url)) {
      void updateMonitorTargetForTab(tabId, tab, "active")
        .then(() => requestImmediateScan(tabId));
      return;
    }

    void clearStoredSnapshot()
      .then(() => updateMonitorTargetForTab(tabId, tab, "unsupported"));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void markMonitorTargetClosed(tabId);
});
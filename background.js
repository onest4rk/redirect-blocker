/**
 * Redirect Blocker - Background Service Worker
 * Manages per-tab blocked counts, badge text, storage,
 * and webNavigation-based cross-origin blocking.
 */

// Track per-tab blocked counts and last allowed URLs
const tabBlockCounts = {};
const tabLastUrl = {};

// Initialize when extension loads
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['siteAllowlist', 'blockedLog', 'globalDisabled']);

  if (!result.siteAllowlist) {
    await chrome.storage.local.set({ siteAllowlist: [] });
  }
  if (!result.blockedLog) {
    await chrome.storage.local.set({ blockedLog: [] });
  }
  if (!result.globalDisabled) {
    await chrome.storage.local.set({ globalDisabled: false });
  }

  console.log('[Redirect Blocker] Extension installed/updated');
});

// ============================================================================
// webNavigation: Block cross-origin navigations
// ============================================================================
// This catches link clicks and HTTP-level redirects that the content script
// can't intercept (because they bypass JavaScript entirely).
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Only handle main frame (not iframes)
  if (details.frameId !== 0) return;

  // Ignore the very first navigation (initial page load)
  if (!tabLastUrl[details.tabId]) {
    tabLastUrl[details.tabId] = details.url;
    return;
  }

  // Check if blocking is enabled
  const result = await chrome.storage.local.get(['siteAllowlist', 'globalDisabled']);
  if (result.globalDisabled) return;

  const allowlist = result.siteAllowlist || [];

  try {
    const destUrl = new URL(details.url);
    const sourceUrl = new URL(tabLastUrl[details.tabId]);

    // Allow same-origin
    if (destUrl.origin === sourceUrl.origin) {
      tabLastUrl[details.tabId] = details.url;
      return;
    }

    // Allow if destination is in allowlist
    const destHost = destUrl.hostname;
    if (allowlist.includes(destHost)) {
      tabLastUrl[details.tabId] = details.url;
      return;
    }

    // Allow if source is in allowlist
    if (allowlist.includes(sourceUrl.hostname)) {
      tabLastUrl[details.tabId] = details.url;
      return;
    }

    // Block the cross-origin navigation - go back to previous URL
    console.log('[Redirect Blocker] Blocked cross-origin navigation:', details.url, 'from:', tabLastUrl[details.tabId]);

    // Log the blocked event
    logBlockedEvent(sourceUrl.hostname, 'navigation', details.url, tabLastUrl[details.tabId]);

    // Increment blocked count
    if (!tabBlockCounts[details.tabId]) {
      tabBlockCounts[details.tabId] = 0;
    }
    tabBlockCounts[details.tabId]++;
    updateBadge(details.tabId);

    // Navigate back to the previous page
    chrome.tabs.update(details.tabId, { url: tabLastUrl[details.tabId] });

  } catch (e) {
    // Invalid URL, allow it
    tabLastUrl[details.tabId] = details.url;
  }
});

// Track the last valid URL per tab (after successful navigation)
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (details.tabId) {
    tabLastUrl[details.tabId] = details.url;
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'blocked') {
    const tabId = sender.tab?.id;

    if (tabId) {
      if (!tabBlockCounts[tabId]) {
        tabBlockCounts[tabId] = 0;
      }
      tabBlockCounts[tabId]++;

      updateBadge(tabId);

      logBlockedEvent(message.hostname, message.blockType, message.details, message.url);
    }

    sendResponse({ success: true });
  }

  if (message.type === 'getCount') {
    const tabId = message.tabId;
    const count = tabBlockCounts[tabId] || 0;
    sendResponse({ count: count });
    return true;
  }

  if (message.type === 'toggleSite') {
    toggleSiteAllowlist(message.hostname, message.enabled).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'checkSite') {
    checkSiteEnabled(message.hostname).then((enabled) => {
      sendResponse({ enabled: enabled });
    });
    return true;
  }

  if (message.type === 'getBlockedLog') {
    getBlockedLog().then((log) => {
      sendResponse({ log: log });
    });
    return true;
  }

  if (message.type === 'clearLog') {
    chrome.storage.local.set({ blockedLog: [] }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'toggleGlobal') {
    chrome.storage.local.get('globalDisabled').then((result) => {
      const newDisabled = !result.globalDisabled;
      chrome.storage.local.set({ globalDisabled: newDisabled }).then(() => {
        sendResponse({ disabled: newDisabled });
      });
    });
    return true;
  }

  if (message.type === 'getGlobalState') {
    chrome.storage.local.get('globalDisabled').then((result) => {
      sendResponse({ disabled: result.globalDisabled || false });
    });
    return true;
  }

  if (message.type === 'getAllowlist') {
    chrome.storage.local.get('siteAllowlist').then((result) => {
      sendResponse({ allowlist: result.siteAllowlist || [] });
    });
    return true;
  }

  if (message.type === 'addToAllowlist') {
    addToAllowlist(message.hostname).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'removeFromAllowlist') {
    removeFromAllowlist(message.hostname).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'getTabId') {
    sendResponse({ tabId: sender.tab?.id || null });
    return true;
  }
});

/**
 * Update badge text for a tab
 */
function updateBadge(tabId) {
  const count = tabBlockCounts[tabId] || 0;

  if (count > 0) {
    const text = count > 99 ? '99+' : count.toString();
    chrome.action.setBadgeText({ text: text, tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e53935', tabId: tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId: tabId });
  }
}

/**
 * Log a blocked event to storage
 */
async function logBlockedEvent(hostname, blockType, details, pageUrl) {
  const result = await chrome.storage.local.get('blockedLog');
  const log = result.blockedLog || [];

  const entry = {
    timestamp: Date.now(),
    hostname: hostname,
    blockType: blockType,
    details: details || '',
    pageUrl: pageUrl || ''
  };

  log.unshift(entry);

  if (log.length > 500) {
    log.length = 500;
  }

  await chrome.storage.local.set({ blockedLog: log });
}

/**
 * Get the blocked log
 */
async function getBlockedLog() {
  const result = await chrome.storage.local.get('blockedLog');
  return result.blockedLog || [];
}

/**
 * Toggle a site in the allowlist
 */
async function toggleSiteAllowlist(hostname, enabled) {
  const result = await chrome.storage.local.get('siteAllowlist');
  let allowlist = result.siteAllowlist || [];

  if (enabled) {
    if (!allowlist.includes(hostname)) {
      allowlist.push(hostname);
    }
  } else {
    allowlist = allowlist.filter(h => h !== hostname);
  }

  await chrome.storage.local.set({ siteAllowlist: allowlist });

  try {
    const tabs = await chrome.tabs.query({ url: `*://${hostname}/*` });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'stateChanged' }).catch(() => {});
      }
    }
  } catch (e) {}
}

/**
 * Check if a site is enabled (blocking is active)
 */
async function checkSiteEnabled(hostname) {
  const result = await chrome.storage.local.get(['siteAllowlist', 'globalDisabled']);

  if (result.globalDisabled) {
    return false;
  }

  const allowlist = result.siteAllowlist || [];
  return !allowlist.includes(hostname);
}

/**
 * Add a hostname to the allowlist
 */
async function addToAllowlist(hostname) {
  const result = await chrome.storage.local.get('siteAllowlist');
  let allowlist = result.siteAllowlist || [];

  if (!allowlist.includes(hostname)) {
    allowlist.push(hostname);
    await chrome.storage.local.set({ siteAllowlist: allowlist });
  }
}

/**
 * Remove a hostname from the allowlist
 */
async function removeFromAllowlist(hostname) {
  const result = await chrome.storage.local.get('siteAllowlist');
  let allowlist = result.siteAllowlist || [];

  allowlist = allowlist.filter(h => h !== hostname);
  await chrome.storage.local.set({ siteAllowlist: allowlist });
}

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabBlockCounts[tabId];
  delete tabLastUrl[tabId];
});

// Update badge when tab is activated
chrome.tabs.onActivated.addListener((activeInfo) => {
  updateBadge(activeInfo.tabId);
});

// Update badge when tab URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    tabBlockCounts[tabId] = 0;
    updateBadge(tabId);
  }
});

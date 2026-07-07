/**
 * Redirect Blocker - Background Service Worker
 * Manages per-tab blocked counts, badge text, and storage.
 */

// Track per-tab blocked counts
const tabBlockCounts = {};

// Initialize when extension loads
chrome.runtime.onInstalled.addListener(async () => {
  // Set default storage values if not present
  const result = await chrome.storage.local.get(['siteBlocklist', 'blockedLog', 'globalDisabled']);

  if (!result.siteBlocklist) {
    await chrome.storage.local.set({ siteBlocklist: [] });
  }
  if (!result.blockedLog) {
    await chrome.storage.local.set({ blockedLog: [] });
  }
  if (!result.globalDisabled) {
    await chrome.storage.local.set({ globalDisabled: false });
  }

  console.log('[Redirect Blocker] Extension installed/updated');
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'blocked') {
    const tabId = sender.tab?.id;

    if (tabId) {
      // Increment counter for this tab
      if (!tabBlockCounts[tabId]) {
        tabBlockCounts[tabId] = 0;
      }
      tabBlockCounts[tabId]++;

      // Update badge text
      updateBadge(tabId);

      // Log the blocked event
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
    toggleSiteBlocklist(message.hostname, message.enabled).then(() => {
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
    chrome.storage.local.get('siteBlocklist').then((result) => {
      sendResponse({ allowlist: result.siteBlocklist || [] });
    });
    return true;
  }

  if (message.type === 'addToAllowlist') {
    addToBlocklist(message.hostname).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'removeFromAllowlist') {
    removeFromBlocklist(message.hostname).then(() => {
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

  // Only show badge if there are blocks
  try {
    if (count > 0) {
      const text = count > 99 ? '99+' : count.toString();
      chrome.action.setBadgeText({ text: text, tabId: tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#e53935', tabId: tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId: tabId });
    }
  } catch (e) {
    // Tab may have been closed
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

  // Add to beginning of log
  log.unshift(entry);

  // Keep only last 500 entries
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
 * Toggle a site in the blocklist (protected sites)
 */
async function toggleSiteBlocklist(hostname, enabled) {
  const result = await chrome.storage.local.get('siteBlocklist');
  let blocklist = result.siteBlocklist || [];

  if (enabled) {
    // Add to blocklist (blocking enabled)
    if (!blocklist.includes(hostname)) {
      blocklist.push(hostname);
    }
  } else {
    // Remove from blocklist (blocking disabled)
    blocklist = blocklist.filter(h => h !== hostname);
  }

  await chrome.storage.local.set({ siteBlocklist: blocklist });

  // Update all content scripts on this domain
  try {
    const tabs = await chrome.tabs.query({ url: `*://${hostname}/*` });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'stateChanged' }).catch(() => {});
      }
    }
  } catch (e) {
    // Ignore errors
  }
}

/**
 * Check if a site is enabled (blocking is active)
 */
async function checkSiteEnabled(hostname) {
  const result = await chrome.storage.local.get(['siteBlocklist', 'globalDisabled']);

  if (result.globalDisabled) {
    return false;
  }

  const blocklist = result.siteBlocklist || [];
  return blocklist.includes(hostname);
}

/**
 * Add a hostname to the blocklist
 */
async function addToBlocklist(hostname) {
  const result = await chrome.storage.local.get('siteBlocklist');
  let blocklist = result.siteBlocklist || [];

  if (!blocklist.includes(hostname)) {
    blocklist.push(hostname);
    await chrome.storage.local.set({ siteBlocklist: blocklist });
  }
}

/**
 * Remove a hostname from the blocklist
 */
async function removeFromBlocklist(hostname) {
  const result = await chrome.storage.local.get('siteBlocklist');
  let blocklist = result.siteBlocklist || [];

  blocklist = blocklist.filter(h => h !== hostname);
  await chrome.storage.local.set({ siteBlocklist: blocklist });
}

// ============================================================================
// webNavigation: Block cross-origin navigations (catches HTTP redirects)
// ============================================================================
const tabLastUrl = {};

if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.frameId !== 0) return;

    if (!tabLastUrl[details.tabId]) {
      tabLastUrl[details.tabId] = details.url;
      return;
  }

  const result = await chrome.storage.local.get(['siteBlocklist', 'globalDisabled']);
  if (result.globalDisabled) return;

  const blocklist = result.siteBlocklist || [];

  try {
    const dest = new URL(details.url);
    const source = new URL(tabLastUrl[details.tabId]);

    if (dest.origin === source.origin) {
      tabLastUrl[details.tabId] = details.url;
      return;
    }

    // Only block if the source site is in the blocklist (protected site)
    if (!blocklist.includes(source.hostname)) {
      tabLastUrl[details.tabId] = details.url;
      return;
    }

    // Block cross-origin navigation from protected site
    console.log('[Redirect Blocker] webNav blocked:', details.url);
    logBlockedEvent(source.hostname, 'navigation', details.url, tabLastUrl[details.tabId]);

    if (!tabBlockCounts[details.tabId]) tabBlockCounts[details.tabId] = 0;
    tabBlockCounts[details.tabId]++;
    updateBadge(details.tabId);

    // Go back to previous page
    chrome.tabs.update(details.tabId, { url: tabLastUrl[details.tabId] }).catch(() => {});
  } catch (e) {
    tabLastUrl[details.tabId] = details.url;
  }
});

  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) return;
    if (details.tabId) tabLastUrl[details.tabId] = details.url;
  });
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
    // Reset count for new page navigation
    tabBlockCounts[tabId] = 0;
    updateBadge(tabId);
  }
});

/**
 * Redirect Blocker - Popup Script
 * Manages the popup UI: toggle, blocked count, and log display.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const siteToggle = document.getElementById('siteToggle');
  const blockedCount = document.getElementById('blockedCount');
  const blockedCountIcon = document.getElementById('blockedCountIcon');
  const logToggle = document.getElementById('logToggle');
  const logContainer = document.getElementById('logContainer');
  const logList = document.getElementById('logList');
  const optionsLink = document.getElementById('optionsLink');
  const clearLog = document.getElementById('clearLog');

  let currentHostname = '';

  // Get current tab info
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      currentHostname = url.hostname;
    } catch (e) {
      console.error('Invalid URL:', e);
    }
  }

  // Load blocked count for current tab
  async function loadBlockedCount() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'getCount',
        tabId: tab?.id
      });

      if (response && response.count !== undefined) {
        blockedCount.textContent = response.count;
        blockedCountIcon.textContent = response.count > 99 ? '99+' : response.count;
      }
    } catch (e) {
      console.error('Failed to get count:', e);
    }
  }

  // Load site enabled state
  async function loadSiteState() {
    if (!currentHostname) {
      siteToggle.disabled = true;
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'checkSite',
        hostname: currentHostname
      });

      if (response) {
        siteToggle.checked = response.enabled;
      }
    } catch (e) {
      console.error('Failed to check site state:', e);
    }
  }

  // Toggle site allowlist
  siteToggle.addEventListener('change', async () => {
    if (!currentHostname) return;

    const enabled = siteToggle.checked;

    try {
      await chrome.runtime.sendMessage({
        type: 'toggleSite',
        hostname: currentHostname,
        enabled: enabled
      });
    } catch (e) {
      console.error('Failed to toggle site:', e);
    }
  });

  // Toggle log visibility
  logToggle.addEventListener('click', () => {
    const isExpanded = logContainer.classList.toggle('expanded');
    logToggle.classList.toggle('expanded', isExpanded);

    if (isExpanded) {
      loadBlockedLog();
    }
  });

  // Load blocked log
  async function loadBlockedLog() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getBlockedLog' });

      if (response && response.log) {
        displayLog(response.log);
      }
    } catch (e) {
      console.error('Failed to load log:', e);
    }
  }

  // Display log entries
  function displayLog(log) {
    if (!log || log.length === 0) {
      logList.innerHTML = '<div class="log-empty">No blocked events yet</div>';
      return;
    }

    // Show only last 20 entries in popup
    const recentLog = log.slice(0, 20);

    logList.innerHTML = recentLog.map(entry => {
      const time = formatTime(entry.timestamp);
      const type = formatType(entry.blockType);
      const domain = entry.hostname || 'unknown';

      return `
        <div class="log-item">
          <div class="type">${type}</div>
          <div class="domain">${escapeHtml(domain)}</div>
          <div class="time">${time}</div>
        </div>
      `;
    }).join('');
  }

  // Format timestamp
  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;

    return date.toLocaleDateString();
  }

  // Format block type
  function formatType(type) {
    const types = {
      'popup': 'Popup',
      'overlay': 'Overlay',
      'dynamic_overlay': 'Overlay',
      'dynamic_overlay_child': 'Overlay',
      'location': 'Redirect',
      'location_href': 'Redirect',
      'location_replace': 'Redirect',
      'location_assign': 'Redirect',
      'meta_refresh': 'Meta Redirect'
    };
    return types[type] || 'Blocked';
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Open options page
  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Clear log
  clearLog.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'clearLog' });
      logList.innerHTML = '<div class="log-empty">No blocked events yet</div>';
    } catch (e) {
      console.error('Failed to clear log:', e);
    }
  });

  // Initial load
  loadBlockedCount();
  loadSiteState();
});

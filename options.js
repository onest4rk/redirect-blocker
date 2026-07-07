/**
 * Redirect Blocker - Options Page Script
 * Manages the options page UI and storage interactions.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const globalToggle = document.getElementById('globalToggle');
  const domainInput = document.getElementById('domainInput');
  const addBtn = document.getElementById('addBtn');
  const allowlist = document.getElementById('allowlist');
  const blockedLog = document.getElementById('blockedLog');
  const totalBlocked = document.getElementById('totalBlocked');
  const allowlistCount = document.getElementById('allowlistCount');

  // Load and display stats
  async function loadStats() {
    const result = await chrome.storage.local.get(['blockedLog', 'siteBlocklist']);

    const log = result.blockedLog || [];
    totalBlocked.textContent = log.length;

    const blocklistArr = result.siteBlocklist || [];
    allowlistCount.textContent = blocklistArr.length;
  }

  // Load global state
  async function loadGlobalState() {
    const result = await chrome.storage.local.get('globalDisabled');
    globalToggle.checked = result.globalDisabled || false;
  }

  // Toggle global disable
  globalToggle.addEventListener('change', async () => {
    const disabled = globalToggle.checked;
    await chrome.storage.local.set({ globalDisabled: disabled });
    loadStats();
  });

  // Load and display blocklist
  async function loadBlocklist() {
    const result = await chrome.storage.local.get('siteBlocklist');
    const list = result.siteBlocklist || [];

    if (list.length === 0) {
      allowlist.innerHTML = '<div class="empty-state">No protected sites yet</div>';
      return;
    }

    allowlist.innerHTML = list.map(domain => `
      <div class="domain-item">
        <span class="domain-name">${escapeHtml(domain)}</span>
        <button class="remove-btn" data-domain="${escapeHtml(domain)}">Remove</button>
      </div>
    `).join('');

    // Add remove handlers
    allowlist.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const domain = btn.dataset.domain;
        await removeFromBlocklist(domain);
        loadBlocklist();
        loadStats();
      });
    });
  }

  // Add domain to blocklist
  addBtn.addEventListener('click', async () => {
    const domain = domainInput.value.trim();
    if (domain) {
      await addToBlocklist(domain);
      domainInput.value = '';
      loadBlocklist();
      loadStats();
    }
  });

  // Handle Enter key in input
  domainInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addBtn.click();
    }
  });

  // Add domain to blocklist
  async function addToBlocklist(domain) {
    // Normalize: remove protocol and trailing slash
    domain = domain
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .toLowerCase();

    const result = await chrome.storage.local.get('siteBlocklist');
    let list = result.siteBlocklist || [];

    if (!list.includes(domain)) {
      list.push(domain);
      await chrome.storage.local.set({ siteBlocklist: list });
    }
  }

  // Remove domain from blocklist
  async function removeFromBlocklist(domain) {
    const result = await chrome.storage.local.get('siteBlocklist');
    let list = result.siteBlocklist || [];

    list = list.filter(d => d !== domain);
    await chrome.storage.local.set({ siteBlocklist: list });
  }

  // Load and display blocked log
  async function loadBlockedLog() {
    const result = await chrome.storage.local.get('blockedLog');
    const log = result.blockedLog || [];

    if (log.length === 0) {
      blockedLog.innerHTML = '<div class="empty-state">No blocked events</div>';
      return;
    }

    // Show last 100 entries
    const recentLog = log.slice(0, 100);

    blockedLog.innerHTML = recentLog.map(entry => {
      const time = formatTime(entry.timestamp);
      const type = formatType(entry.blockType);
      const domain = entry.hostname || 'unknown';

      return `
        <div class="domain-item">
          <div>
            <span class="domain-name">${escapeHtml(domain)}</span>
            <div style="font-size: 12px; color: #888; margin-top: 4px;">
              ${type} - ${time}
            </div>
          </div>
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
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

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

  // Initial load
  await loadStats();
  await loadGlobalState();
  await loadBlocklist();
  await loadBlockedLog();
});

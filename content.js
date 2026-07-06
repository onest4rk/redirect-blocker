/**
 * Redirect Blocker - Content Script
 * Injected at document_start on all pages.
 *
 * Blocks ALL popups, cross-origin redirects, and suspicious link clicks.
 * Only same-origin navigation is allowed.
 */

(() => {
  'use strict';

  let blockedCount = 0;
  let isExtensionEnabled = true;

  async function loadState() {
    try {
      const hostname = window.location.hostname;
      const result = await chrome.storage.local.get('siteAllowlist');
      const allowlist = result.siteAllowlist || [];
      isExtensionEnabled = !allowlist.includes(hostname);
      const parts = hostname.split('.');
      for (let i = 1; i < parts.length; i++) {
        if (allowlist.includes(parts.slice(i).join('.'))) {
          isExtensionEnabled = false;
          break;
        }
      }
      const g = await chrome.storage.local.get('globalDisabled');
      if (g.globalDisabled) isExtensionEnabled = false;
    } catch (e) {}
  }

  loadState();
  chrome.storage.onChanged.addListener((c) => {
    if (c.siteAllowlist || c.globalDisabled) loadState();
  });

  function reportBlocked(type, details) {
    blockedCount++;
    try {
      chrome.runtime.sendMessage({
        type: 'blocked', tabId: null,
        url: window.location.href, hostname: window.location.hostname,
        blockType: type, details: details || ''
      });
    } catch (e) {}
  }

  function showToast(url) {
    try {
      let h = '';
      try { h = new URL(url).hostname; } catch (e) { h = String(url).substring(0, 60); }
      const old = document.getElementById('rb-toast');
      if (old) old.remove();
      const d = document.createElement('div');
      d.id = 'rb-toast';
      d.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#1a1a2e;color:#e0e0e0;border:1px solid #e53935;border-radius:8px;padding:12px 16px;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.4);max-width:340px;animation:rb-in .3s ease';
      d.innerHTML = '<span style="color:#e53935;font-weight:600">Blocked</span><br><span style="color:#8ab4f8;font-size:12px">' + esc(h) + '</span>';
      if (!document.getElementById('rb-s')) {
        const s = document.createElement('style');
        s.id = 'rb-s';
        s.textContent = '@keyframes rb-in{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}';
        document.head.appendChild(s);
      }
      (document.body || document.documentElement).appendChild(d);
      setTimeout(() => { d.style.transition = 'opacity .3s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 300); }, 3000);
    } catch (e) {}
  }

  function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

  // ====================================================================
  // 1. BLOCK ALL window.open
  // ====================================================================
  window.open = function () {
    if (!isExtensionEnabled) return null;
    reportBlocked('popup', arguments[0] || '');
    showToast(arguments[0] || 'popup');
    return null;
  };

  // ====================================================================
  // 2. BLOCK ALL cross-origin location redirects
  // ====================================================================
  function isBlocked(v) {
    if (!v || typeof v !== 'string' || !isExtensionEnabled) return false;
    if (v.startsWith('/') || v.startsWith('./') || v.startsWith('../') || v.startsWith('#')) return false;
    try {
      const p = new URL(v, location.origin);
      if (p.protocol === 'javascript:' || p.protocol === 'data:') return true;
      if (p.origin === location.origin) return false;
      return true;
    } catch (e) { return true; }
  }

  const lp = Object.getPrototypeOf(location);
  const hd = Object.getOwnPropertyDescriptor(lp, 'href');
  if (hd && hd.set) {
    try {
      Object.defineProperty(lp, 'href', {
        configurable: true, enumerable: hd.enumerable, get: hd.get,
        set: function (v) {
          if (!isBlocked(v)) return hd.set.call(this, v);
          reportBlocked('location_href', v); showToast(v);
        }
      });
    } catch (e) {}
  }

  const oa = lp.assign;
  if (typeof oa === 'function') lp.assign = function (u) {
    if (!isBlocked(u)) return oa.call(this, u);
    reportBlocked('location_assign', u); showToast(u);
  };

  const or2 = lp.replace;
  if (typeof or2 === 'function') lp.replace = function (u) {
    if (!isBlocked(u)) return or2.call(this, u);
    reportBlocked('location_replace', u); showToast(u);
  };

  const od = Object.getOwnPropertyDescriptor(window, 'location');
  if (od && od.configurable) {
    try {
      Object.defineProperty(window, 'location', {
        get: function () { return od.get.call(this); },
        set: function (v) {
          if (!isBlocked(v)) return od.set.call(this, v);
          reportBlocked('location', v); showToast(v);
        },
        configurable: true
      });
    } catch (e) {}
  }

  // ====================================================================
  // 3. INTERCEPT ALL LINK CLICKS -- block cross-origin <a> navigations
  //    This is the KEY fix for casino popups from real <a> tags.
  // ====================================================================
  document.addEventListener('click', (e) => {
    if (!isExtensionEnabled) return;

    let el = e.target;

    // Walk up to find the closest <a> tag
    while (el && el !== document.body && el !== document.documentElement) {
      const tag = el.tagName?.toLowerCase();

      // Found an <a> tag -- check if it goes cross-origin
      if (tag === 'a') {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('data:')) {
          try {
            const target = new URL(href, location.origin);
            // Block cross-origin link clicks
            if (target.origin !== location.origin) {
              e.stopPropagation();
              e.preventDefault();
              e.stopImmediatePropagation();
              reportBlocked('link_click', href);
              showToast(href);
              console.log('[Redirect Blocker] Blocked cross-origin link click:', href);
              return;
            }
          } catch (e) {}
        }
        // Same-origin link -- let it through
        return;
      }

      // Check for overlay/fake elements
      if (isOverlay(el)) {
        e.stopPropagation();
        e.preventDefault();
        e.stopImmediatePropagation();
        reportBlocked('overlay', el.tagName);
        return;
      }

      el = el.parentElement;
    }
  }, true);

  // ====================================================================
  // 4. OVERLAY / FAKE AD DETECTION
  // ====================================================================
  function isOverlay(el) {
    if (!el || el === document.body) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (s.position !== 'fixed' && s.position !== 'absolute') return false;
    const z = parseInt(s.zIndex, 10) || 0;
    const o = parseFloat(s.opacity) || 1;
    if (z < 100 || o > 0.3) return false;
    const r = el.getBoundingClientRect();
    if (r.width < innerWidth * 0.3 || r.height < innerHeight * 0.3) return false;
    const tag = el.tagName.toLowerCase();
    if (['button', 'input', 'select', 'textarea', 'label'].includes(tag)) return false;
    return true;
  }

  // ====================================================================
  // 5. MUTATION OBSERVER -- remove overlays as they appear
  // ====================================================================
  function clean(root) {
    if (!root || !isExtensionEnabled) return;
    if (root.nodeType === Node.ELEMENT_NODE && isOverlay(root)) {
      root.remove(); reportBlocked('dyn_overlay', root.tagName); return;
    }
    if (root.querySelectorAll) {
      root.querySelectorAll('*').forEach(el => {
        if (isOverlay(el)) { el.remove(); reportBlocked('dyn_overlay_child', el.tagName); }
      });
    }
  }

  const mo = new MutationObserver((ms) => {
    if (!isExtensionEnabled) return;
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) clean(n);
  });

  if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }));

  // ====================================================================
  // 6. BLOCK <meta http-equiv="refresh">
  // ====================================================================
  function checkMeta(n) {
    if (!n || n.nodeType !== 1) return;
    if (n.tagName === 'META' && (n.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') {
      if (isExtensionEnabled) { n.remove(); reportBlocked('meta_refresh', n.getAttribute('content') || ''); }
      return;
    }
    if (n.querySelectorAll) n.querySelectorAll('meta[http-equiv]').forEach(checkMeta);
  }

  checkMeta(document.documentElement);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) checkMeta(n); })
    .observe(document.documentElement || document, { childList: true, subtree: true });

  // ====================================================================
  // 7. Clean existing overlays on load
  // ====================================================================
  function cleanExisting() {
    if (!isExtensionEnabled || !document.body) return;
    document.querySelectorAll('*').forEach(el => {
      if (isOverlay(el)) { el.remove(); reportBlocked('existing_overlay', el.tagName); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cleanExisting);
  else cleanExisting();

})();

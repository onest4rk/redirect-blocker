/**
 * Redirect Blocker - Content Script
 * Injected at document_start on all pages.
 *
 * Aggressive mode: blocks ALL popups and ALL cross-origin redirects.
 * Only same-origin navigation is allowed.
 */

(() => {
  'use strict';

  let blockedCount = 0;
  let isExtensionEnabled = true;

  // Load extension state for current domain
  async function loadState() {
    try {
      const hostname = window.location.hostname;
      const result = await chrome.storage.local.get('siteAllowlist');
      const allowlist = result.siteAllowlist || [];
      isExtensionEnabled = !allowlist.includes(hostname);

      const parts = hostname.split('.');
      for (let i = 1; i < parts.length; i++) {
        const domain = parts.slice(i).join('.');
        if (allowlist.includes(domain)) {
          isExtensionEnabled = false;
          break;
        }
      }

      const globalResult = await chrome.storage.local.get('globalDisabled');
      if (globalResult.globalDisabled) {
        isExtensionEnabled = false;
      }
    } catch (e) {
      // Extension context may be invalidated
    }
  }

  loadState();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.siteAllowlist || changes.globalDisabled) {
      loadState();
    }
  });

  function reportBlocked(type, details) {
    blockedCount++;
    try {
      chrome.runtime.sendMessage({
        type: 'blocked',
        tabId: null,
        url: window.location.href,
        hostname: window.location.hostname,
        blockType: type,
        details: details || ''
      });
    } catch (e) {}
  }

  function showBlockedNotification(url) {
    try {
      let hostname = '';
      try { hostname = new URL(url).hostname; } catch (e) { hostname = url; }

      const existing = document.getElementById('rb-blocked-toast');
      if (existing) existing.remove();

      const notice = document.createElement('div');
      notice.id = 'rb-blocked-toast';
      notice.style.cssText = `
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background: #1a1a2e; color: #e0e0e0; border: 1px solid #e53935;
        border-radius: 8px; padding: 12px 16px; font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4); max-width: 340px;
        animation: rb-slide-in 0.3s ease;
      `;
      notice.innerHTML =
        '<span style="color:#e53935;font-weight:600;">Blocked</span><br>' +
        '<span style="color:#8ab4f8;font-size:12px;">' + escapeHtml(hostname) + '</span>';

      if (!document.getElementById('rb-toast-style')) {
        const s = document.createElement('style');
        s.id = 'rb-toast-style';
        s.textContent = '@keyframes rb-slide-in{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}';
        document.head.appendChild(s);
      }

      (document.body || document.documentElement).appendChild(notice);
      setTimeout(() => {
        notice.style.transition = 'opacity 0.3s';
        notice.style.opacity = '0';
        setTimeout(() => notice.remove(), 300);
      }, 3000);
    } catch (e) {}
  }

  function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  // ============================================================================
  // 1. BLOCK ALL window.open (popups)
  // ============================================================================
  window.open = function () {
    if (!isExtensionEnabled) {
      return null;
    }
    reportBlocked('popup', arguments[0] || 'empty');
    showBlockedNotification(arguments[0] || 'popup');
    console.log('[Redirect Blocker] Blocked window.open:', arguments[0]);
    return null;
  };

  // ============================================================================
  // 2. BLOCK ALL location redirects (href, assign, replace)
  //    Only same-origin navigation is allowed.
  // ============================================================================

  function isBlocked(value) {
    if (!value || typeof value !== 'string') return false;
    if (!isExtensionEnabled) return false;

    // Allow relative paths (same-page navigation)
    if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('#')) {
      return false;
    }

    try {
      const parsed = new URL(value, window.location.origin);

      // Block javascript: and data: URLs
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:') {
        return true;
      }

      // Allow same-origin
      if (parsed.origin === window.location.origin) {
        return false;
      }

      // Block ALL cross-origin
      return true;
    } catch (e) {
      return true;
    }
  }

  // Override location.href
  const locationProto = Object.getPrototypeOf(window.location);
  const origHrefDesc = Object.getOwnPropertyDescriptor(locationProto, 'href');

  if (origHrefDesc && origHrefDesc.set) {
    try {
      Object.defineProperty(locationProto, 'href', {
        configurable: true,
        enumerable: origHrefDesc.enumerable,
        get: origHrefDesc.get,
        set: function (value) {
          if (!isBlocked(value)) {
            return origHrefDesc.set.call(this, value);
          }
          reportBlocked('location_href', value);
          showBlockedNotification(value);
          console.log('[Redirect Blocker] Blocked location.href:', value);
        }
      });
    } catch (e) {
      console.log('[Redirect Blocker] Could not override location.href:', e.message);
    }
  }

  // Override location.assign
  const origAssign = locationProto.assign;
  if (typeof origAssign === 'function') {
    locationProto.assign = function (url) {
      if (!isBlocked(url)) {
        return origAssign.call(this, url);
      }
      reportBlocked('location_assign', url);
      showBlockedNotification(url);
      console.log('[Redirect Blocker] Blocked location.assign:', url);
    };
  }

  // Override location.replace
  const origReplace = locationProto.replace;
  if (typeof origReplace === 'function') {
    locationProto.replace = function (url) {
      if (!isBlocked(url)) {
        return origReplace.call(this, url);
      }
      reportBlocked('location_replace', url);
      showBlockedNotification(url);
      console.log('[Redirect Blocker] Blocked location.replace:', url);
    };
  }

  // Override window.location setter
  const origLocationDesc = Object.getOwnPropertyDescriptor(window, 'location');
  if (origLocationDesc && origLocationDesc.configurable) {
    try {
      Object.defineProperty(window, 'location', {
        get: function () { return origLocationDesc.get.call(this); },
        set: function (value) {
          if (!isBlocked(value)) {
            return origLocationDesc.set.call(this, value);
          }
          reportBlocked('location', value);
          showBlockedNotification(value);
          console.log('[Redirect Blocker] Blocked window.location:', value);
        },
        configurable: true
      });
    } catch (e) {}
  }

  // ============================================================================
  // 3. Block <meta http-equiv="refresh">
  // ============================================================================
  function checkMetaNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'META') {
      const equiv = (node.getAttribute('http-equiv') || '').toLowerCase();
      if (equiv === 'refresh') {
        if (!isExtensionEnabled) return;
        node.remove();
        reportBlocked('meta_refresh', node.getAttribute('content') || '');
        console.log('[Redirect Blocker] Removed meta-refresh');
      }
      return;
    }
    if (node.querySelectorAll) {
      node.querySelectorAll('meta[http-equiv]').forEach(checkMetaNode);
    }
  }

  checkMetaNode(document.documentElement);

  const metaObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) checkMetaNode(n);
    }
  });
  metaObserver.observe(document.documentElement || document, {
    childList: true, subtree: true
  });

  // ============================================================================
  // 4. Remove invisible overlay hijacking elements
  // ============================================================================
  function detectOverlayHijacking(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (s.position !== 'fixed' && s.position !== 'absolute') return false;
    if ((parseInt(s.zIndex, 10) || 0) < 1000) return false;
    if ((parseFloat(s.opacity) || 1) > 0.1) return false;

    const r = el.getBoundingClientRect();
    if (r.width < window.innerWidth * 0.5 || r.height < window.innerHeight * 0.5) return false;

    const tag = el.tagName.toLowerCase();
    if (['button', 'input', 'select', 'textarea'].includes(tag)) return false;

    return true;
  }

  document.addEventListener('click', (e) => {
    if (!isExtensionEnabled) return;
    let el = e.target;
    while (el && el !== document.body) {
      if (detectOverlayHijacking(el)) {
        e.stopPropagation();
        e.preventDefault();
        reportBlocked('overlay', el.tagName);
        console.log('[Redirect Blocker] Neutralized overlay click');
        return;
      }
      el = el.parentElement;
    }
  }, true);

  const overlayObserver = new MutationObserver((mutations) => {
    if (!isExtensionEnabled) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        if (detectOverlayHijacking(n)) {
          n.remove();
          reportBlocked('dynamic_overlay', n.tagName);
        }
        if (n.querySelectorAll) {
          n.querySelectorAll('[style*="z-index: 9999"], [style*="z-index: 99999"], [style*="z-index: 999999"]').forEach(child => {
            if (detectOverlayHijacking(child)) {
              child.remove();
              reportBlocked('dynamic_overlay_child', child.tagName);
            }
          });
        }
      }
    }
  });

  if (document.body) {
    overlayObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      overlayObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

})();

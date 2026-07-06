/**
 * Redirect Blocker - Content Script
 * Injected at document_start on all pages.
 *
 * Strong mode: blocks ALL popups and cross-origin redirects.
 * Aggressively detects and removes overlay hijacking elements.
 * Only same-origin navigation is allowed via JS.
 */

(() => {
  'use strict';

  let blockedCount = 0;
  let isExtensionEnabled = true;

  // ============================================================================
  // Load extension state
  // ============================================================================
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
    } catch (e) {}
  }

  loadState();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.siteAllowlist || changes.globalDisabled) loadState();
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
      try { hostname = new URL(url).hostname; } catch (e) { hostname = String(url).substring(0, 60); }

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
        '<span style="color:#e53935;font-weight:600;">Redirect blocked</span><br>' +
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
  //    Only allow if the click was on a real <a> tag with an href.
  // ============================================================================
  window.open = function (url) {
    if (!isExtensionEnabled) return null;
    reportBlocked('popup', url || 'empty');
    showBlockedNotification(url || 'popup');
    console.log('[Redirect Blocker] Blocked window.open:', url);
    return null;
  };

  // ============================================================================
  // 2. BLOCK ALL location redirects (href, assign, replace)
  //    Only same-origin navigation is allowed.
  // ============================================================================

  function isBlocked(value) {
    if (!value || typeof value !== 'string') return false;
    if (!isExtensionEnabled) return false;

    // Allow relative paths
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
    } catch (e) {}
  }

  // Override location.assign
  const origAssign = locationProto.assign;
  if (typeof origAssign === 'function') {
    locationProto.assign = function (url) {
      if (!isBlocked(url)) return origAssign.call(this, url);
      reportBlocked('location_assign', url);
      showBlockedNotification(url);
      console.log('[Redirect Blocker] Blocked location.assign:', url);
    };
  }

  // Override location.replace
  const origReplace = locationProto.replace;
  if (typeof origReplace === 'function') {
    locationProto.replace = function (url) {
      if (!isBlocked(url)) return origReplace.call(this, url);
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
          if (!isBlocked(value)) return origLocationDesc.set.call(this, value);
          reportBlocked('location', value);
          showBlockedNotification(value);
          console.log('[Redirect Blocker] Blocked window.location:', value);
        },
        configurable: true
      });
    } catch (e) {}
  }

  // ============================================================================
  // 3. PROACTIVE CLICK INTERCEPTION
  //    Before any click handler runs, check if the click target is inside
  //    a suspicious element. If so, block the click entirely so no redirect
  //    handler can fire.
  // ============================================================================

  // Aggressive overlay detection -- catches movie site hijacking patterns
  function isSuspiciousElement(el) {
    if (!el || el === document.body || el === document.documentElement) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const position = style.position;
    if (position !== 'fixed' && position !== 'absolute') return false;

    const zIndex = parseInt(style.zIndex, 10) || 0;
    const opacity = parseFloat(style.opacity) || 1;

    // Relaxed thresholds: catch more patterns
    if (zIndex < 100) return false;
    if (opacity > 0.3) return false;

    // Check if it covers a significant portion of the viewport
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.3 || rect.height < window.innerHeight * 0.3) return false;

    // Check if it has an onclick, href, or any event listener that could redirect
    const hasClickHandler = el.onclick || el.getAttribute('onclick') ||
      el.hasAttribute('href') || el.hasAttribute('data-href');

    // Skip form elements
    const tag = el.tagName.toLowerCase();
    if (['button', 'input', 'select', 'textarea', 'label'].includes(tag)) return false;

    return true;
  }

  // Check if an element is a fake ad button/link (not a real navigation element)
  function isFakeAdElement(el) {
    if (!el) return false;

    const tag = el.tagName.toLowerCase();

    // Real links with actual hrefs are OK
    if (tag === 'a') {
      const href = el.getAttribute('href');
      // A real link has an href that points somewhere meaningful
      if (href && href !== '#' && href !== 'javascript:void(0)' && !href.startsWith('javascript:')) {
        return false; // It's a real link, don't block
      }
    }

    // Check for suspicious attributes
    const style = window.getComputedStyle(el);
    const hasHighZIndex = (parseInt(style.zIndex, 10) || 0) > 100;
    const isFixed = style.position === 'fixed' || style.position === 'absolute';
    const isTransparent = (parseFloat(style.opacity) || 1) < 0.4;
    const hasCursor = style.cursor === 'pointer';

    // Suspicious if: transparent + fixed/absolute + high z-index + pointer cursor
    if (isTransparent && isFixed && hasHighZIndex && hasCursor) {
      return true;
    }

    // Check for elements that cover the whole page with pointer-events
    if (isFixed && hasHighZIndex) {
      const rect = el.getBoundingClientRect();
      if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.8) {
        return true;
      }
    }

    return false;
  }

  // CAPTURE PHASE click interceptor -- runs before ANY other click handler
  document.addEventListener('click', (event) => {
    if (!isExtensionEnabled) return;

    const target = event.target;
    let el = target;

    // Walk up from click target to check for overlays and fake elements
    while (el && el !== document.body && el !== document.documentElement) {
      if (isSuspiciousElement(el)) {
        event.stopPropagation();
        event.preventDefault();
        event.stopImmediatePropagation();
        reportBlocked('overlay', el.tagName + ' z:' + window.getComputedStyle(el).zIndex);
        console.log('[Redirect Blocker] Blocked click on suspicious overlay:', el);
        return;
      }

      if (isFakeAdElement(el)) {
        event.stopPropagation();
        event.preventDefault();
        event.stopImmediatePropagation();
        reportBlocked('fake_ad', el.tagName);
        console.log('[Redirect Blocker] Blocked click on fake ad element:', el);
        return;
      }

      el = el.parentElement;
    }
  }, true);

  // ============================================================================
  // 4. MUTATION OBSERVER: Remove overlays and suspicious elements as they appear
  // ============================================================================

  function removeSuspiciousNodes(root) {
    if (!root || !isExtensionEnabled) return;

    // Check the node itself
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (isSuspiciousElement(root) || isFakeAdElement(root)) {
        root.remove();
        reportBlocked('dynamic_overlay', root.tagName);
        console.log('[Redirect Blocker] Removed suspicious element:', root);
        return;
      }
    }

    // Check all children
    if (root.querySelectorAll) {
      // Remove elements with very high z-index and low opacity
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (isSuspiciousElement(el) || isFakeAdElement(el)) {
          el.remove();
          reportBlocked('dynamic_overlay_child', el.tagName);
        }
      }
    }
  }

  const overlayObserver = new MutationObserver((mutations) => {
    if (!isExtensionEnabled) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          removeSuspiciousNodes(n);
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

  // ============================================================================
  // 5. BLOCK <meta http-equiv="refresh">
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
  // 6. Clean up existing overlays on page load
  // ============================================================================
  // Run once after DOM is ready to remove any overlays already present
  function cleanExistingOverlays() {
    if (!isExtensionEnabled || !document.body) return;
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (isSuspiciousElement(el) || isFakeAdElement(el)) {
        el.remove();
        reportBlocked('existing_overlay', el.tagName);
        console.log('[Redirect Blocker] Removed existing overlay on load:', el);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cleanExistingOverlays);
  } else {
    cleanExistingOverlays();
  }

})();

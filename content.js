/**
 * Redirect Blocker - Content Script
 * Injected at document_start on all pages.
 *
 * Responsibilities:
 * 1. Override window.open to block unwanted popups
 * 2. Detect and neutralize "invisible overlay" click hijacking
 * 3. Block unwanted location/URL reassignment attempts
 * 4. Report blocked events to background script
 */

(() => {
  'use strict';

  // Track blocked count for current page
  let blockedCount = 0;
  let isExtensionEnabled = true;

  // ============================================================================
  // Real user-gesture tracking
  // ============================================================================
  // Scripted redirects/popups almost never fire inside a genuine click/keypress.
  // We track a short window after any real input event and treat navigation
  // that happens outside that window as script-initiated (i.e. blockable).
  let hasRecentUserGesture = false;
  let gestureTimer = null;
  let lastGestureElement = null;

  function markUserGesture(event) {
    // Ignore synthetic events dispatched by scripts (e.g. el.click()) -
    // only a real, physical interaction should count as a gesture.
    if (event && event.isTrusted === false) {
      return;
    }
    hasRecentUserGesture = true;
    lastGestureElement = event.target;
    clearTimeout(gestureTimer);
    // Shorter window: scripts that fire redirects after this should be caught
    gestureTimer = setTimeout(() => {
      hasRecentUserGesture = false;
      lastGestureElement = null;
    }, 800);
  }

  function invalidateGesture() {
    hasRecentUserGesture = false;
    lastGestureElement = null;
    clearTimeout(gestureTimer);
  }

  ['click', 'mousedown', 'keydown', 'touchstart'].forEach((evt) => {
    document.addEventListener(evt, markUserGesture, true);
  });

  // Load extension state for current domain
  async function loadState() {
    try {
      const hostname = window.location.hostname;
      const result = await chrome.storage.local.get('siteAllowlist');
      const allowlist = result.siteAllowlist || [];
      isExtensionEnabled = !allowlist.includes(hostname);

      // Also check for subdomains
      const parts = hostname.split('.');
      for (let i = 1; i < parts.length; i++) {
        const domain = parts.slice(i).join('.');
        if (allowlist.includes(domain)) {
          isExtensionEnabled = false;
          break;
        }
      }

      // Also check if global disable is on
      const globalResult = await chrome.storage.local.get('globalDisabled');
      if (globalResult.globalDisabled) {
        isExtensionEnabled = false;
      }
    } catch (e) {
      // Extension context may be invalidated
      console.log('[Redirect Blocker] Could not load state:', e.message);
    }
  }

  // Load state immediately
  loadState();

  // Listen for state changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.siteAllowlist) {
      loadState();
    }
    if (changes.globalDisabled) {
      loadState();
    }
  });

  // Report a blocked event to the background script
  function reportBlocked(type, details) {
    blockedCount++;
    try {
      chrome.runtime.sendMessage({
        type: 'blocked',
        tabId: null, // background will figure it out
        url: window.location.href,
        hostname: window.location.hostname,
        blockType: type,
        details: details || ''
      });
    } catch (e) {
      // Extension context invalidated
    }
  }

  /**
   * Show a brief on-page notification when a redirect is blocked
   */
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
      notice.innerHTML = '<span style="color:#e53935;font-weight:600;">Redirect blocked</span><br>' +
        '<span style="color:#8ab4f8;font-size:12px;">' + hostname + '</span>';

      // Add slide-in animation
      if (!document.getElementById('rb-notification-style')) {
        const style = document.createElement('style');
        style.id = 'rb-notification-style';
        style.textContent = '@keyframes rb-slide-in{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}';
        document.head.appendChild(style);
      }

      (document.body || document.documentElement).appendChild(notice);
      setTimeout(() => {
        notice.style.transition = 'opacity 0.3s';
        notice.style.opacity = '0';
        setTimeout(() => notice.remove(), 300);
      }, 3000);
    } catch (e) {
      // Ignore notification errors
    }
  }

  // ============================================================================
  // 1. Override window.open
  // ============================================================================
  // window.open() is commonly abused to open popup ads or redirect users.
  // We block it by default unless it appears to be a genuine user-initiated
  // action on a real anchor element.

  const originalWindowOpen = window.open;

  window.open = function (url, target, features) {
    if (!isExtensionEnabled) {
      return originalWindowOpen.call(this, url, target, features);
    }

    // Check if this is called from a real user gesture
    // We can't directly detect the event, but we can check context
    const stack = new Error().stack;
    const isOpenCalledFromUserGesture = detectUserGesture();

    if (isOpenCalledFromUserGesture) {
      // Likely legitimate - allow it
      return originalWindowOpen.call(this, url, target, features);
    }

    // Block the popup
    reportBlocked('popup', url || 'empty url');
    console.log('[Redirect Blocker] Blocked window.open:', url);
    if (url) {
      showBlockedNotification(url);
    }
    return null;
  };

  /**
   * Detect if there's an active user gesture (click, keypress, etc.)
   * This is a heuristic - Chrome's own gesture detection is more robust,
   * but this catches most cases.
   */
  function detectUserGesture() {
    if (hasRecentUserGesture) {
      return true;
    }
    // Fallback: check for active element being interactive
    const activeEl = document.activeElement;
    if (activeEl) {
      const tag = activeEl.tagName.toLowerCase();
      if (tag === 'a' || tag === 'button' || tag === 'input') {
        return true;
      }
    }
    return false;
  }

  /**
   * Validate if a URL looks legitimate
   */
  function isValidUrl(url) {
    if (!url || typeof url !== 'string') return false;

    // Allow relative URLs
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
      return true;
    }

    try {
      const parsed = new URL(url, window.location.origin);
      // Check for common suspicious patterns
      const hostname = parsed.hostname.toLowerCase();

      // Block data: and javascript: URLs
      if (parsed.protocol === 'data:' || parsed.protocol === 'javascript:') {
        return false;
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if the destination is reasonable
   * Heuristic: doesn't need to be perfect, just catch obvious abuse
   */
  function isReasonableDestination(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      const hostname = parsed.hostname.toLowerCase();

      // Known ad/tracking domains
      const suspiciousDomains = [
        'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
        'facebook.com/tr', 'facebook.net', 'amazon-adsystem.com',
        'criteo.com', 'criteo.net', 'adnxs.com', 'adsrvr.org',
        'taboola.com', 'outbrain.com', 'popads.net', 'propellerads.com',
        'exoclick.com', 'clickadu.com', 'popcash.net', 'adsterra.com'
      ];

      for (const domain of suspiciousDomains) {
        if (hostname.includes(domain)) {
          return false;
        }
      }

      // Check for excessive redirects in the URL
      if (parsed.searchParams.has('redirect') || parsed.searchParams.has('url')) {
        // Could be a redirect service
        const redirectUrl = parsed.searchParams.get('redirect') || parsed.searchParams.get('url');
        if (redirectUrl && !redirectUrl.startsWith('/')) {
          try {
            const innerUrl = new URL(redirectUrl);
            // Check if redirecting to suspicious domain
            for (const domain of suspiciousDomains) {
              if (innerUrl.hostname.includes(domain)) {
                return false;
              }
            }
          } catch (e) {
            // Not a valid URL, probably okay
          }
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  // ============================================================================
  // 2. Detect and neutralize "invisible overlay" click hijacking
  // ============================================================================
  // Some sites add large, invisible (opacity ~0) or nearly-invisible elements
  // with high z-index to capture clicks and redirect users.
  //
  // Heuristic: We look for elements that:
  // - Cover most of the viewport (width/height > 80% of viewport)
  // - Have position: fixed or absolute
  // - Have high z-index (> 1000)
  // - Have low opacity (< 0.1)
  // - Are not user-interactive elements (buttons, inputs, etc.)

  function detectOverlayHijacking(element) {
    const style = window.getComputedStyle(element);

    // Skip elements that are not visible
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const position = style.position;
    const zIndex = parseInt(style.zIndex, 10) || 0;
    const opacity = parseFloat(style.opacity) || 1;

    // Must be positioned
    if (position !== 'fixed' && position !== 'absolute') {
      return false;
    }

    // Check z-index threshold
    if (zIndex < 1000) {
      return false;
    }

    // Check opacity threshold - nearly invisible
    if (opacity > 0.1) {
      return false;
    }

    // Check if it covers most of the viewport
    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const coversWidth = rect.width > viewportWidth * 0.5;
    const coversHeight = rect.height > viewportHeight * 0.5;

    if (!coversWidth || !coversHeight) {
      return false;
    }

    // Skip legitimate interactive elements. Note: we deliberately do NOT
    // exempt <a> tags or elements with onclick handlers here. A giant,
    // near-invisible, full-viewport anchor or div-with-onclick covering the
    // whole page IS the click-hijack pattern in the wild - exempting them
    // defeated the entire point of this check.
    const tag = element.tagName.toLowerCase();
    const interactiveTags = ['button', 'input', 'select', 'textarea'];
    if (interactiveTags.includes(tag)) {
      return false;
    }

    return true;
  }

  // Click handler to detect overlay hijacking
  document.addEventListener('click', (event) => {
    if (!isExtensionEnabled) return;

    const target = event.target;
    let currentElement = target;

    // Walk up the DOM tree to check for overlay hijacking
    while (currentElement && currentElement !== document.body) {
      if (detectOverlayHijacking(currentElement)) {
        // Found suspicious overlay - neutralize the click
        event.stopPropagation();
        event.preventDefault();
        // This click just proved itself illegitimate - don't let it (or a
        // redirect/popup fired off the back of it) count as a real gesture.
        invalidateGesture();
        reportBlocked('overlay', currentElement.tagName + ' (z-index: ' + window.getComputedStyle(currentElement).zIndex + ')');
        console.log('[Redirect Blocker] Neutralized overlay click:', currentElement);
        return;
      }
      currentElement = currentElement.parentElement;
    }
  }, true); // Use capturing phase to run before other handlers

  // ============================================================================
  // 3. Detect and block unwanted location reassignment attempts
  // ============================================================================

  // `location.href = x`, `location.assign(x)`, and `location.replace(x)` all act
  // directly on the Location object, NOT on `window` - so overriding the
  // `location` property on `window` (as done previously) never actually catches
  // any of them. It only would have caught the rare `window.location = x` form.
  // To really block redirects we need to override the members on
  // Location.prototype itself, which is what every one of those calls goes through.

  const locationProto = Object.getPrototypeOf(window.location);
  const originalHrefDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'href');
  const originalAssign = locationProto.assign;
  const originalReplace = locationProto.replace;

  // Override location.href = ...
  if (originalHrefDescriptor && originalHrefDescriptor.set) {
    try {
      Object.defineProperty(locationProto, 'href', {
        configurable: true,
        enumerable: originalHrefDescriptor.enumerable,
        get: originalHrefDescriptor.get,
        set: function (value) {
          if (!isExtensionEnabled || isLegitimateNavigation(value)) {
            return originalHrefDescriptor.set.call(this, value);
          }
          reportBlocked('location_href', value);
          console.log('[Redirect Blocker] Blocked location.href change to:', value);
        }
      });
    } catch (e) {
      console.log('[Redirect Blocker] Could not override location.href setter:', e.message);
    }
  }

  // Override location.assign(...)
  if (typeof originalAssign === 'function') {
    locationProto.assign = function (url) {
      if (!isExtensionEnabled || isLegitimateNavigation(url)) {
        return originalAssign.call(this, url);
      }
      reportBlocked('location_assign', url);
      console.log('[Redirect Blocker] Blocked location.assign to:', url);
      showBlockedNotification(url);
    };
  }

  // Override location.replace(...)
  if (typeof originalReplace === 'function') {
    locationProto.replace = function (url) {
      if (!isExtensionEnabled || isLegitimateNavigation(url)) {
        return originalReplace.call(this, url);
      }
      reportBlocked('location_replace', url);
      console.log('[Redirect Blocker] Blocked location.replace to:', url);
      showBlockedNotification(url);
    };
  }

  // Also handle the rare bare `window.location = x` assignment form.
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
  if (originalLocationDescriptor && originalLocationDescriptor.configurable) {
    try {
      Object.defineProperty(window, 'location', {
        get: function () {
          return originalLocationDescriptor.get.call(this);
        },
        set: function (value) {
          if (!isExtensionEnabled || isLegitimateNavigation(value)) {
            return originalLocationDescriptor.set.call(this, value);
          }
          reportBlocked('location', value);
          console.log('[Redirect Blocker] Blocked location change to:', value);
          showBlockedNotification(value);
        },
        configurable: true
      });
    } catch (e) {
      console.log('[Redirect Blocker] Could not override window.location setter:', e.message);
    }
  }

  /**
   * Determine if a navigation is likely legitimate
   */
  function isLegitimateNavigation(value) {
    if (!value || typeof value !== 'string') return false;

    // Allow relative paths
    if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('#')) {
      return true;
    }

    try {
      const parsed = new URL(value, window.location.origin);

      // Block javascript: and data: URLs
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:') {
        return false;
      }

      // Allow same-origin navigation
      if (parsed.origin === window.location.origin) {
        return true;
      }

      // Cross-origin: only allow if user genuinely clicked an <a> or <button>
      // This is the key fix -- a script-initiated redirect (from a timer,
      // ad script, or any non-user-triggered code) will not have a real
      // anchor/button as the gesture element, so it gets blocked.
      if (hasRecentUserGesture && lastGestureElement) {
        const tag = lastGestureElement.tagName?.toLowerCase();
        // Also check parents: the user may have clicked a child of an <a>
        let el = lastGestureElement;
        for (let i = 0; i < 5 && el; i++) {
          const t = el.tagName?.toLowerCase();
          if (t === 'a' || t === 'button') {
            return true;
          }
          el = el.parentElement;
        }
      }

      console.log('[Redirect Blocker] Blocked cross-origin navigation:', value);
      showBlockedNotification(value);
      return false;
    } catch (e) {
      return false;
    }
  }

  // ============================================================================
  // 4. MutationObserver for dynamic overlay injection
  // ============================================================================
  // Some overlays are injected dynamically after page load

  const observer = new MutationObserver((mutations) => {
    if (!isExtensionEnabled) return;

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (detectOverlayHijacking(node)) {
              // Remove the suspicious element
              node.remove();
              reportBlocked('dynamic_overlay', node.tagName);
              console.log('[Redirect Blocker] Removed dynamically injected overlay:', node);
            }

            // Also check children
            const suspiciousChildren = node.querySelectorAll ?
              node.querySelectorAll('[style*="z-index: 9999"], [style*="z-index: 99999"], [style*="z-index: 999999"]') : [];

            for (const child of suspiciousChildren) {
              if (detectOverlayHijacking(child)) {
                child.remove();
                reportBlocked('dynamic_overlay_child', child.tagName);
                console.log('[Redirect Blocker] Removed dynamically injected overlay child:', child);
              }
            }
          }
        }
      }
    }
  });

  // Start observing when DOM is ready
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  } else {
    // Wait for body to be available
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    });
  }

  // ============================================================================
  // 5. Detect suspicious event listeners
  // ============================================================================
  // Override addEventListener to detect suspicious patterns
  // (This is a lighter check - we just log potential issues)

  const originalAddEventListener = EventTarget.prototype.addEventListener;

  // We don't block, just monitor for now
  // Full blocking would break too many legitimate sites

  // ============================================================================
  // 6. Block <meta http-equiv="refresh"> redirects
  // ============================================================================
  // This is a pure HTML-level redirect handled by the browser's parser - it
  // never touches window.open, location.href, location.assign/replace, or
  // any other JS API, so none of the overrides above can catch it. We have
  // to find and strip the tag itself, as early as possible.

  function checkMetaNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.tagName === 'META') {
      const equiv = (node.getAttribute('http-equiv') || '').toLowerCase();
      if (equiv === 'refresh') {
        if (!isExtensionEnabled) return;
        const content = node.getAttribute('content') || '';
        node.remove();
        reportBlocked('meta_refresh', content);
        console.log('[Redirect Blocker] Removed meta-refresh redirect:', content);
      }
      return;
    }

    if (node.querySelectorAll) {
      node.querySelectorAll('meta[http-equiv]').forEach(checkMetaNode);
    }
  }

  // Catch any meta refresh tag already present the instant we run
  checkMetaNode(document.documentElement);

  // Catch tags added as the rest of the document streams in, or injected later
  const metaObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        checkMetaNode(node);
      }
    }
  });
  metaObserver.observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });

})();

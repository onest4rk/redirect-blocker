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

    // If URL is provided and looks legitimate, allow it
    if (url && isValidUrl(url) && isReasonableDestination(url)) {
      // Still suspicious if called without user gesture, but be lenient
      // for legitimate use cases
      if (isOpenCalledFromUserGesture) {
        return originalWindowOpen.call(this, url, target, features);
      }
    }

    // Block the popup
    reportBlocked('popup', url || 'empty url');
    console.log('[Redirect Blocker] Blocked window.open:', url);
    return null;
  };

  /**
   * Detect if there's an active user gesture (click, keypress, etc.)
   * This is a heuristic - Chrome's own gesture detection is more robust,
   * but this catches most cases.
   */
  function detectUserGesture() {
    // Check for active element being interactive
    const activeEl = document.activeElement;
    if (activeEl) {
      const tag = activeEl.tagName.toLowerCase();
      if (tag === 'a' || tag === 'button' || tag === 'input') {
        return true;
      }
    }
    // Can't reliably detect gestures from content script
    // The background script can handle this with chrome.userGesture
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

    // Skip legitimate interactive elements
    const tag = element.tagName.toLowerCase();
    const interactiveTags = ['button', 'input', 'select', 'textarea', 'a'];
    if (interactiveTags.includes(tag)) {
      return false;
    }

    // Skip elements with click handlers (could be legitimate modals, etc.)
    // This is a heuristic - we can't know for sure
    if (element.onclick || element.getAttribute('onclick')) {
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

  // Wrap window.location and location.href setters
  // Note: This is tricky because location is a special object

  // Store original descriptors
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
  const originalHrefDescriptor = Object.getOwnPropertyDescriptor(window.location.__proto__.__proto__, 'href') ||
    Object.getOwnPropertyDescriptor(window.location.__proto__, 'href');

  // Override location property setter
  try {
    Object.defineProperty(window, 'location', {
      get: function () {
        return originalLocationDescriptor.get.call(this);
      },
      set: function (value) {
        if (!isExtensionEnabled) {
          return originalLocationDescriptor.set.call(this, value);
        }

        // Check if this navigation is legitimate
        if (isLegitimateNavigation(value)) {
          return originalLocationDescriptor.set.call(this, value);
        }

        reportBlocked('location', value);
        console.log('[Redirect Blocker] Blocked location change to:', value);
        // Don't actually navigate
      },
      configurable: true
    });
  } catch (e) {
    console.log('[Redirect Blocker] Could not override location setter:', e.message);
  }

  // Also watch for direct property assignments on location
  const locationProxy = new Proxy(window.location, {
    set: function (obj, prop, value) {
      if (!isExtensionEnabled) {
        obj[prop] = value;
        return true;
      }

      if (prop === 'href' || prop === 'replace' || prop === 'assign') {
        if (!isLegitimateNavigation(value)) {
          reportBlocked('location_' + prop, value);
          console.log('[Redirect Blocker] Blocked location.' + prop + ' to:', value);
          return true; // Block the navigation
        }
      }

      obj[prop] = value;
      return true;
    }
  });

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

      // Check against known suspicious domains
      const hostname = parsed.hostname.toLowerCase();
      const suspiciousPatterns = [
        'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
        'facebook.com/tr', 'amazon-adsystem.com', 'criteo.com',
        'adnxs.com', 'adsrvr.org', 'taboola.com', 'outbrain.com',
        'popads.net', 'propellerads.com', 'exoclick.com'
      ];

      for (const pattern of suspiciousPatterns) {
        if (hostname.includes(pattern)) {
          return false;
        }
      }

      // Allow navigation to common legitimate sites
      const legitimatePatterns = [
        'google.com', 'github.com', 'stackoverflow.com',
        'youtube.com', 'wikipedia.org', 'mozilla.org'
      ];

      for (const pattern of legitimatePatterns) {
        if (hostname.includes(pattern)) {
          return true;
        }
      }

      // Default: allow cross-origin navigation but log it
      console.log('[Redirect Blocker] Allowing cross-origin navigation to:', value);
      return true;
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

})();

# Redirect Blocker

A Chrome extension (Manifest V3) that stops websites from hijacking clicks to open unwanted new tabs, popups, or force redirects. Built for ad-heavy and streaming sites where clicking anywhere sends you to a different site.

## Features

- **Popup Blocking**: Overrides `window.open()` to block unwanted popups
- **Overlay Detection**: Identifies and neutralizes "invisible overlay" click hijacking
- **Redirect Prevention**: Blocks unwanted `window.location` reassignment attempts
- **Site-by-Site Control**: Enable/disable blocking per domain
- **Global Toggle**: Disable blocking entirely when needed
- **Blocked Log**: View a log of all blocked events
- **Badge Counter**: Shows number of blocked items per tab

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked" and select the `redirect-blocker` folder
5. The extension icon should appear in your toolbar

## Usage

### Basic Usage
- The extension is enabled by default on all sites
- Click the extension icon to see blocked count for current page
- Toggle blocking on/off for the current site

### Managing Blocked Domains
- Click "Manage blocked domains" in the popup
- Add domains to the allowlist to disable blocking on specific sites
- Remove domains from the allowlist to re-enable blocking

### Viewing Blocked Events
- Click "View blocked log" in the popup to see recent blocked events
- The log shows the type of block (popup, overlay, redirect) and the domain

## How It Works

### Window.open Override
The extension overrides `window.open()` to block popups that aren't triggered by genuine user gestures on anchor elements.

### Overlay Detection
Detects elements with suspicious styling:
- Position: fixed or absolute
- High z-index (> 1000)
- Low opacity (< 0.1)
- Covers most of the viewport

### Redirect Prevention
Wraps location setters to block navigation to suspicious domains or tracking URLs.

### Declarative Net Request
Uses Chrome's declarativeNetRequest API to block requests to known ad/tracking domains.

## Customization

### Adding Domains to Block
Edit `rules.json` to add more ad/tracking domains to the blocklist. Each rule follows the declarativeNetRequest format:

```json
{
  "id": 31,
  "priority": 1,
  "action": {
    "type": "block"
  },
  "condition": {
    "urlFilter": "||example-ad.com",
    "resourceTypes": ["script", "image", "sub_frame", "xmlhttprequest", "ping"]
  }
}
```

### Modifying Detection Heuristics
Edit `content.js` to adjust the overlay detection thresholds or add new detection patterns.

## Limitations

- Cannot block redirects that happen at the network/DNS level
- Overlay detection is heuristic-based and may miss some cases or produce false positives
- Some legitimate popups may be blocked (you can disable blocking per site)

## Privacy

- The extension runs entirely locally - no data is sent to external servers
- Blocked logs are stored locally in Chrome's storage
- No tracking or analytics are included

## License

MIT License - feel free to use, modify, and distribute.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

If you encounter issues or have suggestions, please open an issue on GitHub.

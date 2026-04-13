# YT Playlist Finder

A Tampermonkey userscript that finds a YouTube playlist containing the current video from the same artist.

## Installation

**Prerequisites:** Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.

**Install the script:**

1. **[Click here to install](https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/yt-playlist-finder.user.js)**
2. Tampermonkey will open and show the script — click **Install**
3. Navigate to any YouTube video and the script will run automatically

## Updating

Tampermonkey checks for updates automatically via the `@updateURL` metadata. You can also manually update:

1. Open Tampermonkey dashboard
2. Go to the **Utilities** tab
3. Click **Check for userscript updates**

## Development

The project consists of two files:

- `yt-playlist-finder.user.js` — The main userscript
- `yt-playlist-finder.meta.js` — Metadata-only file used by Tampermonkey for lightweight update checks (must be kept in sync with the userscript header)

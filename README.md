# YT Playlist Finder

A Tampermonkey userscript that adds a button to YouTube video pages to find which of the channel's playlists contain the current video. Useful for discovering series, collections, or themed playlists from a creator while watching their content.

## How It Works

When you're watching a YouTube video, a small button appears in the action bar (next to Like, Share, Download, etc.). Clicking it opens a modal that:

1. Fetches all playlists from the video's channel
2. Checks each playlist to see if it contains the current video
3. Shows you the results in two tabs: **Matched** (playlists with this video) and **All** (every playlist)

Clicking a matched playlist opens the current video within that playlist context, so you can see other videos in the series. Clicking an unmatched playlist opens the playlist page directly.

All data is fetched using YouTube's internal API — no API key needed, no quotas, no configuration.

## Features

- **Matched / All tabs** — Quickly see which playlists contain the current video, or browse all playlists from the channel
- **Background loading** — Closing the modal doesn't stop loading. Reopen it anytime to see live progress
- **Caching** — Playlist data is cached for 24 hours. Revisiting the same channel loads instantly
- **Resume from cache** — If loading is interrupted (page refresh, navigation), it picks up where it left off
- **Search and sort** — Filter playlists by name and sort by title or video count on the All tab
- **Activity log** — Collapsible log panel in the modal showing real-time loading activity
- **Cache controls** — Refresh, Clear Channel, and Clear All buttons for managing cached data
- **SPA-aware** — Handles YouTube's single-page navigation, re-injects the button on each video page

## Installation

**Prerequisites:** Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.

**Install the script:**

1. **[Click here to install](https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/yt-playlist-finder.user.js)**
2. Tampermonkey will open and show the script — click **Install**
3. Navigate to any YouTube video and the button will appear in the action bar

## Updating

Tampermonkey checks for updates automatically via the `@updateURL` metadata. You can also manually update:

1. Open Tampermonkey dashboard
2. Go to the **Utilities** tab
3. Click **Check for userscript updates**

## Development

The project consists of two files:

- `yt-playlist-finder.user.js` — The main userscript (single file, no build step)
- `yt-playlist-finder.meta.js` — Metadata-only header used by Tampermonkey for lightweight update checks (must be kept in sync with the userscript header)

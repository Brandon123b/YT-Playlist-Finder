# YT Playlist Finder

> Instantly find every playlist on a YouTube channel that contains the video you're watching.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Greasy Fork](https://img.shields.io/greasyfork/dt/575319?label=Greasy%20Fork%20installs&color=670000)](https://greasyfork.org/en/scripts/575319-yt-playlist-finder)
[![Install](https://img.shields.io/badge/install-yt--playlist--finder.user.js-3ea6ff?logo=youtube&logoColor=white)](https://greasyfork.org/en/scripts/575319-yt-playlist-finder)

<p align="center">
  <img src="https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/docs/Demo.gif" alt="YT Playlist Finder demo" width="850">
</p>

## What it does

YouTube doesn't tell you which playlists a video belongs to. This script does.

Click the button next to **Like / Share** on any video, and a panel opens listing every playlist **on the same channel** that contains the video — plus every other playlist the channel has made, so you can browse the rest.

> **Heads up:** This only finds playlists made by the **same channel** that uploaded the video — not playlists made by other users.

## Features

- Find every playlist on a channel that contains the current video
- Browse and search the channel's full playlist library
- Click a matched playlist to keep watching the video *inside* that playlist
- Caches results for 24 hours — repeat visits load instantly
- No API key, no setup, no configuration

## Screenshots

<p align="center"><strong>The button</strong>, added to every video page next to Like / Share</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/docs/Main.png" alt="Button location" width="600">
</p>

<p align="center"><strong>Matched</strong> — playlists that contain the video you're watching</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/docs/modal.png" alt="Matched tab" width="500">
</p>

<p align="center"><strong>All</strong> — search and sort the channel's full playlist library</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/docs/modal2.png" alt="All tab" width="500">
</p>

## Installation

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) (recommended), [Violentmonkey](https://violentmonkey.github.io/), or [Greasemonkey](https://www.greasespot.net/).
2. **[Install YT Playlist Finder](https://greasyfork.org/en/scripts/575319-yt-playlist-finder)** from Greasy Fork.
3. Open any YouTube video — the button appears next to Like / Share.

## Usage

Click the playlist-icon button on any YouTube video.

- The **Matched** tab shows playlists from this channel that contain the current video. Click one to keep watching the video inside that playlist.
- The **All** tab shows every playlist on the channel, with search and sort.
- Use **Refresh**, **Clear Channel**, or **Clear All** to manage cached data.

> **The first scan of a channel takes a moment.** The script has to fetch every playlist and check each one for the current video. Channels with hundreds of playlists can take 30 seconds or more on the first visit. After that, results are cached for 24 hours and load instantly.

If the in-page button ever fails to appear, you can also open the panel from the userscript manager's menu (**Tampermonkey icon → YT Playlist Finder → Find Playlists**).

## Notes

- Uses YouTube's internal API directly — no third-party servers, no API keys, no quotas. Everything runs in your browser.
- Works on `youtube.com`. Does not work on YouTube Music or YouTube Kids.

## License

[MIT](LICENSE) © Brandon123b

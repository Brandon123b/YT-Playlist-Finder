    // ==UserScript==
    // @name         YT Playlist Finder
    // @namespace    https://github.com/Brandon123b/YT-Playlist-Finder
    // @version      1.0.1
    // @description  Find every playlist on a YouTube channel that contains the video you're watching
    // @author       Brandon123b
    // @match        https://www.youtube.com/*
    // @match        https://youtube.com/*
    // @icon         https://www.youtube.com/favicon.ico
    // @grant        GM_setValue
    // @grant        GM_getValue
    // @grant        GM_deleteValue
    // @grant        GM_listValues
    // @grant        GM_registerMenuCommand
    // @license      MIT
    // @homepageURL  https://github.com/Brandon123b/YT-Playlist-Finder
    // @homepageURL  https://greasyfork.org/en/scripts/575319-yt-playlist-finder
    // @supportURL   https://github.com/Brandon123b/YT-Playlist-Finder/issues
    // @downloadURL  https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/yt-playlist-finder.user.js
    // @updateURL    https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/yt-playlist-finder.meta.js
    // ==/UserScript==

    (function () {
        "use strict";

        // ===== Configuration =====

    const CONFIG = {
        // Cache strategy: we always run a *quick refresh* on the first
        // button press for a given page (channel + video). Quick refresh
        // re-fetches the channel page sorted by "Last video added" and
        // paginates only until it hits a playlist that hasn't changed
        // since the cache was saved, then re-fetches changed playlists
        // and re-verifies cached matches. There is no TTL: in-session
        // caches are trusted for repeat opens of the same modal, but
        // navigating to another video or hitting Refresh always rescans.
        // The wall-clock cost of one quick refresh (~1 channel-page
        // fetch + a tiny continuation tail) is small enough that the
        // old TTL stopped being worth its complexity.
        CACHE_PREFIX: "cache_",
        // No artificial throttle. YouTube's InnerTube `browse` endpoint
        // accepts back-to-back requests over HTTP/2 multiplexing without
        // pushback when authenticated with the page's own session token.
        // If we ever start seeing 429s, raise this back to 100-300ms.
        FETCH_DELAY_MS: 0,
        // Aggressive parallelism. Browser caps per-origin at ~6 over HTTP/1.1
        // but YouTube uses HTTP/2 so multiplexing pushes the practical
        // ceiling much higher; 10 keeps a comfortable buffer.
        PARALLEL_FETCHES: 10,
        // Hard cap on the activity-log buffer so a giant channel can't
        // accumulate unbounded DOM work for rebuildLogPanel().
        MAX_LOG_ENTRIES: 500,
    };

        const LOG_PREFIX = "[YT Playlist Finder]";

        // ===== Utilities =====

        function extractYtInitialData(html) {
            const markers = ["var ytInitialData = ", "ytInitialData = "];
            for (const marker of markers) {
                const start = html.indexOf(marker);
                if (start === -1) continue;
                const jsonStart = start + marker.length;

                let depth = 0;
                for (let i = jsonStart; i < html.length; i++) {
                    if (html[i] === "{") depth++;
                    else if (html[i] === "}") {
                        depth--;
                        if (depth === 0) {
                            try {
                                return JSON.parse(html.substring(jsonStart, i + 1));
                            } catch (e) {
                                return null;
                            }
                        }
                    }
                }
            }
            return null;
        }

        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        function clearChildren(el) {
            el.textContent = "";
        }

        function createSpinner() {
            const span = document.createElement("span");
            span.className = "ytpf-spinner";
            return span;
        }

        function createPlaylistIcon() {
            const NS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(NS, "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "currentColor");
            const path = document.createElementNS(NS, "path");
            path.setAttribute("d", "M22 7H2v1h20V7zm-9 5H2v-1h11v1zm0 4H2v-1h11v1zm2 3v-8l7 4-7 4z");
            svg.appendChild(path);
            return svg;
        }

        // ===== Cache Layer =====

        function cacheGet(channelId) {
            return GM_getValue(CONFIG.CACHE_PREFIX + channelId, null);
        }

        function cacheSet(channelId, data) {
            data.lastChecked = Date.now();
            GM_setValue(CONFIG.CACHE_PREFIX + channelId, data);
        }

        function cacheDeleteChannel(channelId) {
            GM_deleteValue(CONFIG.CACHE_PREFIX + channelId);
        }

    function cacheDeleteAll() {
        for (const key of GM_listValues()) {
            if (key.startsWith(CONFIG.CACHE_PREFIX)) GM_deleteValue(key);
        }
    }

    // ===== Page Data Extraction =====

        // Reads channel/video info for the current /watch page.
        //
        // Notes on correctness:
        //   * unsafeWindow.ytInitialPlayerResponse can be stale across SPA
        //     navigations (it briefly holds the previous video's data), so we
        //     only trust it when its videoId matches the URL we're on right now.
        //   * Modern YouTube renders the channel owner link as /@HandleName
        //     rather than /channel/UCxxxxx, so href-based lookups frequently
        //     miss. The Polymer `data` property on <ytd-video-owner-renderer>
        //     still carries the structured browseId regardless of the visible
        //     URL form, which is the most reliable DOM-side source.
        //   * The "wrong channel" bug came from a document-wide
        //     a[href*="/channel/UC"] fallback that picked up the *viewer's*
        //     avatar link in the masthead first. We keep that fallback as a
        //     last resort but explicitly exclude masthead/topbar containers.
        function findChannelIdInPolymerData(data, depth) {
            if (!data || typeof data !== "object" || depth > 4) return null;
            const direct = data.navigationEndpoint?.browseEndpoint?.browseId
                || data.browseEndpoint?.browseId;
            if (typeof direct === "string" && direct.startsWith("UC")) return direct;
            for (const key of ["title", "subtitle", "owner", "videoOwnerRenderer"]) {
                const found = findChannelIdInPolymerData(data[key], depth + 1);
                if (found) return found;
            }
            if (Array.isArray(data.runs)) {
                for (const run of data.runs) {
                    const found = findChannelIdInPolymerData(run, depth + 1);
                    if (found) return found;
                }
            }
            return null;
        }

        function getPageInfo() {
            const info = { videoId: null, channelId: null, channelName: null };

            info.videoId = new URLSearchParams(location.search).get("v");
            if (!info.videoId) {
                info.videoId = document.querySelector('meta[itemprop="videoId"]')?.content || null;
            }

            try {
                const pr = unsafeWindow?.ytInitialPlayerResponse;
                const prVideoId = pr?.videoDetails?.videoId;
                if (pr?.videoDetails?.channelId && (!info.videoId || prVideoId === info.videoId)) {
                    info.channelId = pr.videoDetails.channelId;
                    if (pr.videoDetails.author) info.channelName = pr.videoDetails.author;
                }
            } catch (_) {}

            if (!info.channelId) {
                try {
                    const ownerEl = document.querySelector(
                        "ytd-watch-metadata ytd-video-owner-renderer, ytd-video-owner-renderer"
                    );
                    const data = ownerEl?.data || ownerEl?.__data?.data;
                    const id = findChannelIdInPolymerData(data, 0);
                    if (id) info.channelId = id;
                } catch (_) {}
            }

            if (!info.channelId) {
                const ownerLink = document.querySelector(
                    "ytd-watch-metadata ytd-video-owner-renderer a[href*='/channel/UC'],"
                    + "ytd-watch-metadata #channel-name a[href*='/channel/UC'],"
                    + "ytd-watch-metadata #upload-info a[href*='/channel/UC'],"
                    + "ytd-video-owner-renderer a[href*='/channel/UC']"
                );
                if (ownerLink) {
                    const m = ownerLink.getAttribute("href")?.match(/\/channel\/(UC[\w-]+)/)
                        || ownerLink.href.match(/\/channel\/(UC[\w-]+)/);
                    if (m) info.channelId = m[1];
                }
            }

            if (!info.channelId) {
                try {
                    const yt = unsafeWindow?.ytInitialData;
                    const contents = yt?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
                    if (contents) {
                        for (const item of contents) {
                            const owner = item?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
                            const id = owner?.navigationEndpoint?.browseEndpoint?.browseId;
                            if (id) { info.channelId = id; break; }
                        }
                    }
                } catch (_) {}
            }

            // Last-resort document-wide scan, with masthead/topbar excluded so
            // we never pick up the viewer's own avatar link.
            if (!info.channelId) {
                const links = document.querySelectorAll('a[href*="/channel/UC"]');
                for (const link of links) {
                    if (link.closest("ytd-masthead, #masthead, #masthead-container, ytd-topbar-menu-button-renderer, tp-yt-iron-dropdown")) continue;
                    const m = link.getAttribute("href")?.match(/\/channel\/(UC[\w-]+)/)
                        || link.href.match(/\/channel\/(UC[\w-]+)/);
                    if (m) { info.channelId = m[1]; break; }
                }
            }

            if (!info.channelName) {
                const nameEl = document.querySelector(
                    "ytd-watch-metadata #channel-name a, ytd-video-owner-renderer #channel-name a"
                );
                if (nameEl) info.channelName = nameEl.textContent.trim();
            }

            return info;
        }

        // ===== InnerTube Helpers =====

        function getInnerTubeContext() {
            try {
                const cfg = unsafeWindow?.ytcfg?.data_;
                if (cfg) return { apiKey: cfg.INNERTUBE_API_KEY, context: cfg.INNERTUBE_CONTEXT };
            } catch (_) {}
            return null;
        }

        async function innerTubeBrowse(continuationToken) {
            const tube = getInnerTubeContext();
            if (!tube) throw new Error("Could not get InnerTube context");

            const res = await fetch(`/youtubei/v1/browse?key=${tube.apiKey}&prettyPrint=false`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ context: tube.context, continuation: continuationToken }),
            });
            if (!res.ok) throw new Error(`InnerTube browse failed: ${res.status}`);
            return res.json();
        }

        // Calls /youtubei/v1/browse with a fresh browseId + optional params
        // (rather than a continuation token). Used to start a sorted view
        // of a channel's playlists tab without going through the HTML page.
        async function innerTubeBrowseInitial(browseId, params) {
            const tube = getInnerTubeContext();
            if (!tube) throw new Error("Could not get InnerTube context");

            const body = { context: tube.context, browseId };
            if (params) body.params = params;

            const res = await fetch(`/youtubei/v1/browse?key=${tube.apiKey}&prettyPrint=false`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`InnerTube browse failed: ${res.status}`);
            return res.json();
        }

        // ===== Data Parsing =====

        function findPlaylistRenderers(obj, results = []) {
            if (!obj || typeof obj !== "object") return results;

            if (obj.gridPlaylistRenderer) results.push(obj.gridPlaylistRenderer);
            if (obj.playlistRenderer) results.push(obj.playlistRenderer);
            if (obj.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST") {
                results.push({ _lockup: obj.lockupViewModel });
            }

            for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (Array.isArray(val)) {
                    for (const item of val) findPlaylistRenderers(item, results);
                } else if (val && typeof val === "object") {
                    findPlaylistRenderers(val, results);
                }
            }
            return results;
        }

        function extractVideoCountFromObj(obj, depth = 0) {
            if (depth > 10 || !obj) return 0;
            if (typeof obj === "string") {
                const m = obj.match(/(\d[\d,]*)\s*video/i);
                if (m) return parseInt(m[1].replace(/,/g, "")) || 0;
                return 0;
            }
            if (typeof obj !== "object") return 0;
            for (const key of Object.keys(obj)) {
                const found = extractVideoCountFromObj(obj[key], depth + 1);
                if (found > 0) return found;
            }
            return 0;
        }

        // Parses YouTube's relative time strings ("Updated 3 days ago",
        // "Last updated 2 weeks ago", etc.) into an approximate absolute
        // timestamp in milliseconds. Returns null if no parseable phrase
        // is found.
        //
        // Day-level granularity is plenty for our staleness comparisons:
        // a playlist whose videos changed within the last 12 hours always
        // shows up as "Updated X hours ago" anyway, and false-positive
        // refreshes (we re-fetch a playlist we didn't strictly need to)
        // are cheap.
        const RELATIVE_TIME_UNITS = {
            second: 1000,
            minute: 60 * 1000,
            hour: 60 * 60 * 1000,
            day: 24 * 60 * 60 * 1000,
            week: 7 * 24 * 60 * 60 * 1000,
            month: 30 * 24 * 60 * 60 * 1000,
            year: 365 * 24 * 60 * 60 * 1000,
        };
        function parseRelativeTimeToAbsolute(str) {
            if (!str) return null;
            const s = String(str).toLowerCase();

            // YouTube uses several special-case strings for very recent
            // updates. We map them to approximate absolute times so they
            // sort correctly and survive the lastUpdated > T comparison.
            if (/\bjust\s*now\b/.test(s)) return Date.now();
            if (/\b(?:a\s+few|seconds?)\b.*\bago\b/.test(s)) return Date.now() - 30 * 1000;
            if (/\btoday\b/.test(s)) return Date.now();
            if (/\byesterday\b/.test(s)) return Date.now() - 24 * 60 * 60 * 1000;

            const m = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
            if (!m) return null;
            const n = parseInt(m[1], 10);
            const unit = m[2];
            const ms = RELATIVE_TIME_UNITS[unit];
            if (!ms || !n) return null;
            return Date.now() - n * ms;
        }

        // Walks a playlist renderer's metadata strings looking for the
        // "Updated X ago" phrase. Returns absolute ms timestamp or null.
        function extractLastUpdatedFromObj(obj, depth = 0) {
            if (depth > 6 || !obj) return null;
            if (typeof obj === "string") {
                if (/updated/i.test(obj) || /\bago\b/i.test(obj)) {
                    return parseRelativeTimeToAbsolute(obj);
                }
                return null;
            }
            if (typeof obj !== "object") return null;
            for (const key of Object.keys(obj)) {
                const t = extractLastUpdatedFromObj(obj[key], depth + 1);
                if (t) return t;
            }
            return null;
        }

        function parsePlaylistRenderer(renderer) {
            if (renderer._lockup) {
                const lk = renderer._lockup;
                const id = lk.contentId;
                const title = lk.metadata?.lockupMetadataViewModel?.title?.content;
                const thumb = lk.contentImage?.collectionThumbnailViewModel
                    ?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url;

                let videoCount = 0;
                let lastUpdated = null;
                const metaRows = lk.metadata?.lockupMetadataViewModel?.metadata
                    ?.contentMetadataViewModel?.metadataRows;
                // Restrict the videoCount fallback to strings that actually
                // mention "video". The previous "any number wins" fallback
                // could happily pick up dates like "Updated 3 days ago"
                // and report videoCount=3 for a non-empty playlist whose
                // metadata rows didn't lead with the video count.
                if (metaRows) {
                    for (const row of metaRows) {
                        for (const part of (row.metadataParts || [])) {
                            const txt = part?.text?.content;
                            if (!txt) continue;
                            if (!videoCount && /video/i.test(txt)) {
                                const n = parseInt(String(txt).replace(/[^0-9]/g, ""));
                                if (n > 0) videoCount = n;
                            }
                            if (!lastUpdated) {
                                const t = parseRelativeTimeToAbsolute(txt);
                                if (t) lastUpdated = t;
                            }
                        }
                        if (videoCount && lastUpdated) break;
                    }
                }
                if (!videoCount) videoCount = extractVideoCountFromObj(lk.contentImage);
                if (!videoCount) videoCount = extractVideoCountFromObj(lk);
                if (!lastUpdated) lastUpdated = extractLastUpdatedFromObj(lk);

                if (id && title) return { id, title, thumbnailUrl: thumb || "", videoCount, lastUpdated, videoIds: null, lastChecked: null };
                return null;
            }

            const id = renderer.playlistId;
            const title = renderer.title?.simpleText || renderer.title?.runs?.[0]?.text;
            const thumbs = renderer.thumbnail?.thumbnails
                || renderer.thumbnailRenderer?.playlistVideoThumbnailRenderer?.thumbnail?.thumbnails;
            const thumbnailUrl = thumbs?.[thumbs.length - 1]?.url || "";
            const cntRaw = renderer.videoCountShortText?.simpleText
                || renderer.videoCountText?.runs?.[0]?.text
                || renderer.videoCount || "0";
            let videoCount = parseInt(String(cntRaw).replace(/[^0-9]/g, "")) || 0;
            if (!videoCount) videoCount = extractVideoCountFromObj(renderer.thumbnailOverlays);
            if (!videoCount) videoCount = extractVideoCountFromObj(renderer);
            const lastUpdated = extractLastUpdatedFromObj(renderer);

            if (id && title) return { id, title, thumbnailUrl, videoCount, lastUpdated, videoIds: null, lastChecked: null };
            return null;
        }

        function findContinuationToken(obj) {
            if (!obj || typeof obj !== "object") return null;
            if (obj.continuationCommand?.token) return obj.continuationCommand.token;

            for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (Array.isArray(val)) {
                    for (const item of val) {
                        const t = findContinuationToken(item);
                        if (t) return t;
                    }
                } else if (val && typeof val === "object") {
                    const t = findContinuationToken(val);
                    if (t) return t;
                }
            }
            return null;
        }

        // ===== API: Fetch Channel Playlists =====

        // Walks an InnerTube response looking for the playlists-tab sort
        // dropdown (sortFilterSubMenuRenderer). Returns a map of label
        // string -> opaque InnerTube `params` value, e.g.
        //   { "Date added (newest)": "...", "Last video added": "..." }
        // We use this to start a sorted-by-Last-video-added view without
        // hardcoding YouTube's encoded params.
        function findSortParamsByLabel(obj, out = {}, depth = 0) {
            if (!obj || typeof obj !== "object" || depth > 12) return out;
            if (obj.sortFilterSubMenuRenderer?.subMenuItems) {
                for (const item of obj.sortFilterSubMenuRenderer.subMenuItems) {
                    // Newer renderers occasionally hand back `title` as a
                    // structured object ({simpleText:…} or {runs:[…]})
                    // instead of a plain string. Coercing those to a key
                    // gives "[object Object]", silently making
                    // pickSortParam unable to match — and the script then
                    // drops to the slower unsorted-fallback path. Extract
                    // a string explicitly so all the renderer shapes work.
                    const rawTitle = item.title || item.label;
                    const title = typeof rawTitle === "string"
                        ? rawTitle
                        : (rawTitle?.simpleText
                            || rawTitle?.runs?.[0]?.text
                            || null);
                    // Sort options carry their reload params on a
                    // serializeCommand → reloadContinuationItemsCommand →
                    // continuationItems → reloadEndpoint.browseEndpoint.params
                    // OR directly on a navigationEndpoint.browseEndpoint.params.
                    const params = findFirstBrowseParams(item);
                    if (title && params) out[title] = params;
                }
            }
            for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (Array.isArray(val)) {
                    for (const item of val) findSortParamsByLabel(item, out, depth + 1);
                } else if (val && typeof val === "object") {
                    findSortParamsByLabel(val, out, depth + 1);
                }
            }
            return out;
        }
        function findFirstBrowseParams(obj, depth = 0) {
            if (!obj || typeof obj !== "object" || depth > 8) return null;
            if (obj.browseEndpoint?.params) return obj.browseEndpoint.params;
            for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (Array.isArray(val)) {
                    for (const item of val) {
                        const p = findFirstBrowseParams(item, depth + 1);
                        if (p) return p;
                    }
                } else if (val && typeof val === "object") {
                    const p = findFirstBrowseParams(val, depth + 1);
                    if (p) return p;
                }
            }
            return null;
        }

        // Picks a sort param matching one of the candidate labels (case-
        // insensitive substring match). Returns null if no sort dropdown
        // was found or none of the labels matched. Channels without
        // multiple sort options simply return null and we fall back to
        // the default order.
        function pickSortParam(sortMap, candidates) {
            const keys = Object.keys(sortMap);
            for (const cand of candidates) {
                const lower = cand.toLowerCase();
                for (const k of keys) {
                    if (k.toLowerCase().includes(lower)) return sortMap[k];
                }
            }
            return null;
        }

        // Fetches a channel's playlists tab.
        //
        // opts.sortParam:    optional InnerTube sort selector. If supplied
        //                    we hit the InnerTube `browse` endpoint
        //                    directly (no HTML page). Falls back to the
        //                    HTML page if the sort call fails.
        // opts.shouldStop:   optional callback invoked with each parsed
        //                    batch; returning true halts pagination
        //                    immediately. Used by quick refresh to stop
        //                    once we hit a playlist that hasn't changed.
        // opts.returnInitialData: if true, also returns the raw initial
        //                    response so the caller can extract the sort
        //                    dropdown from it. (We only use HTML for the
        //                    very first call when no sortParam is known.)
        async function fetchChannelPlaylists(channelId, onBatch, opts = {}) {
            const { sortParam, shouldStop, returnInitialData } = opts;

            let ytData;
            if (sortParam) {
                try {
                    ytData = await innerTubeBrowseInitial(channelId, sortParam);
                } catch (_) {
                    // Fall through to HTML on InnerTube failure.
                }
            }
            if (!ytData) {
                const res = await fetch(`/channel/${channelId}/playlists`);
                if (!res.ok) throw new Error(`Failed to fetch channel page: ${res.status}`);
                ytData = extractYtInitialData(await res.text());
                if (!ytData) throw new Error("Could not parse ytInitialData from channel page");
            }

            const playlists = [];
            const initialBatch = findPlaylistRenderers(ytData)
                .map(parsePlaylistRenderer)
                .filter(Boolean);
            if (initialBatch.length > 0) {
                playlists.push(...initialBatch);
                if (onBatch) onBatch(initialBatch);
                if (shouldStop && shouldStop(initialBatch)) {
                    return returnInitialData ? { playlists, initialData: ytData } : playlists;
                }
            }

            // We deliberately do NOT swallow continuation errors here:
            // a partial enumeration that gets persisted to cache as if
            // complete would silently lose every playlist past the
            // failure point until the user manually clears the channel.
            // Surfacing the error lets startBackgroundLoad mark the
            // cache as not-fully-enumerated so the next quick refresh
            // forces a full re-pagination.
            let token = findContinuationToken(ytData);
            while (token) {
                if (CONFIG.FETCH_DELAY_MS > 0) await sleep(CONFIG.FETCH_DELAY_MS);
                const data = await innerTubeBrowse(token);
                const newRenderers = [];
                for (const action of (data.onResponseReceivedActions || [])) {
                    findPlaylistRenderers(action.appendContinuationItemsAction?.continuationItems || [], newRenderers);
                }
                const batch = newRenderers.map(parsePlaylistRenderer).filter(Boolean);
                if (batch.length > 0) {
                    playlists.push(...batch);
                    if (onBatch) onBatch(batch);
                    if (shouldStop && shouldStop(batch)) break;
                }
                token = findContinuationToken(data);
            }

            return returnInitialData ? { playlists, initialData: ytData } : playlists;
        }

        // ===== API: Fetch Playlist Video IDs =====

        function extractVideoIdsFromData(data, videoIds) {
            if (!data || typeof data !== "object") return;
            if (data.playlistVideoRenderer?.videoId) {
                videoIds.push(data.playlistVideoRenderer.videoId);
                return;
            }
            for (const key of Object.keys(data)) {
                const val = data[key];
                if (Array.isArray(val)) val.forEach(item => extractVideoIdsFromData(item, videoIds));
                else if (val && typeof val === "object") extractVideoIdsFromData(val, videoIds);
            }
        }

        // Fetches every videoId in a playlist, paginating to completion.
        //
        // We deliberately do NOT short-circuit when targetVideoId is
        // matched: the cached result is reused across future video lookups
        // on the same channel, and a partial videoIds list would silently
        // give wrong answers (false negatives) for any video that lives
        // past the truncation point in this playlist. The marginal cost is
        // small (most playlists are one page; matched playlists are
        // typically 1-3 of N) and the cache becomes permanently correct.
        async function fetchPlaylistVideoIds(playlistId, targetVideoId) {
            const tube = getInnerTubeContext();
            if (!tube) throw new Error("Could not get InnerTube context");

            // Use InnerTube browse directly — returns ~20-50KB JSON instead of ~500KB+ HTML
            const res = await fetch(`/youtubei/v1/browse?key=${tube.apiKey}&prettyPrint=false`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ context: tube.context, browseId: "VL" + playlistId }),
            });
            if (!res.ok) throw new Error(`InnerTube browse failed: ${res.status}`);

            const ytData = await res.json();
            const videoIds = [];
            extractVideoIdsFromData(ytData, videoIds);

            // Continuation errors must propagate. A partial videoIds list
            // would compute containsTarget against a truncated set and
            // silently report a match as "not in playlist" if the target
            // happened to live past the failure point. We'd then cache
            // the truncated list as authoritative and the false-negative
            // would persist for the channel's whole TTL window.
            let token = findContinuationToken(ytData);
            while (token) {
                if (CONFIG.FETCH_DELAY_MS > 0) await sleep(CONFIG.FETCH_DELAY_MS);
                const data = await innerTubeBrowse(token);
                for (const action of (data.onResponseReceivedActions || [])) {
                    for (const item of (action.appendContinuationItemsAction?.continuationItems || [])) {
                        if (item.playlistVideoRenderer?.videoId) {
                            videoIds.push(item.playlistVideoRenderer.videoId);
                        }
                    }
                }
                token = findContinuationToken(data);
            }

            return { videoIds, containsTarget: targetVideoId ? videoIds.includes(targetVideoId) : null };
        }

        // ===== CSS Styles =====

        function injectStyles() {
            if (document.getElementById("ytpf-styles")) return;

            const style = document.createElement("style");
            style.id = "ytpf-styles";
            style.textContent = `
                .ytpf-btn {
                    background: rgba(62, 166, 255, 0.3);
                    border: 1px solid #3ea6ff;
                    color: #f1f1f1;
                    cursor: pointer;
                    padding: 0;
                    border-radius: 50%;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.15s;
                    width: 36px;
                    height: 36px;
                    box-sizing: border-box;
                    flex-shrink: 0;
                    margin-right: 8px;
                }
                .ytpf-btn:hover { background: rgba(62, 166, 255, 0.5); }
                .ytpf-btn svg { width: 20px; height: 20px; }

                .ytpf-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.7);
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .ytpf-modal {
                    background: #212121;
                    border-radius: 12px;
                    width: 90%;
                    max-width: 480px;
                    max-height: 80vh;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                    color: #f1f1f1;
                    font-family: "Roboto", "Arial", sans-serif;
                }

                .ytpf-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 16px;
                    border-bottom: 1px solid #383838;
                    flex-shrink: 0;
                }
                .ytpf-title { font-size: 16px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
                .ytpf-close { background: none; border: none; color: #aaa; font-size: 24px; cursor: pointer; padding: 0 4px; line-height: 1; flex-shrink: 0; }
                .ytpf-close:hover { color: #fff; }

                .ytpf-toolbar { display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid #383838; flex-shrink: 0; }
                .ytpf-toolbar-btn { background: #383838; border: none; color: #aaa; padding: 4px 12px; border-radius: 16px; font-size: 12px; cursor: pointer; transition: background 0.15s, color 0.15s; }
                .ytpf-toolbar-btn:hover { background: #4a4a4a; color: #f1f1f1; }

                .ytpf-tabs { display: flex; border-bottom: 1px solid #383838; flex-shrink: 0; }
                .ytpf-tab { flex: 1; background: none; border: none; border-bottom: 2px solid transparent; color: #aaa; padding: 10px 16px; font-size: 13px; font-weight: 500; cursor: pointer; transition: color 0.15s, border-color 0.15s; }
                .ytpf-tab:hover { color: #f1f1f1; }
                .ytpf-tab.ytpf-tab-active { color: #f1f1f1; border-bottom-color: #3ea6ff; }

                .ytpf-content { flex: 1; overflow-y: auto; padding: 4px 0; min-height: 80px; }
                .ytpf-content::-webkit-scrollbar { width: 8px; }
                .ytpf-content::-webkit-scrollbar-track { background: transparent; }
                .ytpf-content::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }

                .ytpf-playlist-item { display: flex; align-items: center; gap: 12px; padding: 8px 16px; cursor: pointer; transition: background 0.15s; border-left: 3px solid transparent; }
                .ytpf-playlist-item:hover { background: #383838; }
                .ytpf-playlist-item.ytpf-contains-video { border-left-color: #3ea6ff; }

                .ytpf-thumb { width: 100px; height: 56px; object-fit: cover; border-radius: 4px; flex-shrink: 0; background: #181818; }
                .ytpf-info { flex: 1; min-width: 0; }
                .ytpf-pl-title { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .ytpf-pl-count { font-size: 12px; color: #aaa; margin-top: 2px; }

                .ytpf-indicator { flex-shrink: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px; color: #3ea6ff; }

                .ytpf-loading, .ytpf-empty, .ytpf-error { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; padding: 32px 16px; color: #aaa; font-size: 14px; }
                .ytpf-retry { background: #383838; border: none; color: #3ea6ff; padding: 4px 12px; border-radius: 16px; font-size: 12px; cursor: pointer; }
                .ytpf-retry:hover { background: #4a4a4a; }

                .ytpf-filter-bar { display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid #303030; flex-shrink: 0; align-items: center; }
                .ytpf-search { flex: 1; background: #181818; border: 1px solid #383838; border-radius: 8px; padding: 6px 10px; color: #f1f1f1; font-size: 13px; outline: none; font-family: inherit; }
                .ytpf-search:focus { border-color: #3ea6ff; }
                .ytpf-search::placeholder { color: #717171; }
                .ytpf-sort-btn { background: #383838; border: none; color: #aaa; padding: 4px 10px; border-radius: 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
                .ytpf-sort-btn:hover { background: #4a4a4a; color: #f1f1f1; }

                .ytpf-footer { padding: 8px 16px; font-size: 11px; color: #717171; border-top: 1px solid #383838; text-align: center; flex-shrink: 0; }

                .ytpf-log-toggle { padding: 6px 16px; font-size: 11px; color: #717171; cursor: pointer; border-top: 1px solid #383838; flex-shrink: 0; user-select: none; }
                .ytpf-log-toggle:hover { color: #aaa; }
                .ytpf-log-body { max-height: 150px; overflow-y: auto; background: #181818; padding: 4px 8px; font-family: "Consolas", "Monaco", monospace; font-size: 11px; flex-shrink: 0; }
                .ytpf-log-body::-webkit-scrollbar { width: 6px; }
                .ytpf-log-body::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
                .ytpf-log-entry { color: #999; line-height: 1.6; }
                .ytpf-log-time { color: #555; margin-right: 6px; }

                .ytpf-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #555; border-top-color: #3ea6ff; border-radius: 50%; animation: ytpf-spin 0.8s linear infinite; }
                @keyframes ytpf-spin { to { transform: rotate(360deg); } }
            `;
            document.head.appendChild(style);
        }

        // ===== UI State =====

    let bgTask = null;
    let bgGeneration = 0;
    let logEntries = [];
    let currentModal = null;
    // Tracked at module scope so closeModal can detach it on every close path
    // (X button, overlay click, SPA navigate). Previously the Escape handler
    // only detached itself when Escape fired, leaking one document-keydown
    // listener per modal open.
    let modalKeyHandler = null;
    let activeTab = "matched";
        let searchQuery = "";
        let allSortMode = "az"; // "az", "za", "count-desc", "count-asc"

        // Persistent references to the modal's content-area scaffold. Built once
        // when the modal opens, reused across every subsequent render so we
        // never have to clear-and-rebuild the playlist list (which would reset
        // scroll position and burn ~500 DOM-create calls per refresh during
        // active fetching).
        let modalScaffold = null;

        function isBackgroundLoading() {
            return bgTask !== null && !bgTask.done && bgGeneration === bgTask.generation;
        }

        // ===== Activity Log =====

        function modalLog(msg) {
            const entry = { time: new Date(), msg };
            logEntries.push(entry);

            // Cap with FIFO trim. A long-running scan on a giant channel
            // would otherwise grow logEntries indefinitely, which makes
            // every reopen-modal call rebuild thousands of DOM nodes via
            // rebuildLogPanel().
            const overflow = logEntries.length - CONFIG.MAX_LOG_ENTRIES;
            if (overflow > 0) {
                logEntries.splice(0, overflow);
                const body = document.getElementById("ytpf-log-body");
                if (body) {
                    for (let i = 0; i < overflow && body.firstChild; i++) {
                        body.removeChild(body.firstChild);
                    }
                }
            }

            const body = document.getElementById("ytpf-log-body");
            if (body) {
                appendLogEntry(body, entry);
                body.scrollTop = body.scrollHeight;
            }
        }

        function appendLogEntry(container, entry) {
            const div = document.createElement("div");
            div.className = "ytpf-log-entry";

            const timeSpan = document.createElement("span");
            timeSpan.className = "ytpf-log-time";
            const t = entry.time;
            timeSpan.textContent = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;

            div.appendChild(timeSpan);
            div.append(entry.msg);
            container.appendChild(div);
        }

        function rebuildLogPanel() {
            const body = document.getElementById("ytpf-log-body");
            if (!body) return;
            clearChildren(body);
            for (const entry of logEntries) {
                appendLogEntry(body, entry);
            }
            body.scrollTop = body.scrollHeight;
        }

        // ===== Button Injection =====
        //
        // YouTube is a Polymer-based SPA that frequently re-renders the watch-page
        // actions row, which removes any button we attach. To survive that, we
        // keep ensureButton() cheap, synchronous and idempotent, and run it from
        // three independent recovery sources:
        //   1. A MutationObserver on document.body (debounced via rAF).
        //   2. YouTube's own SPA navigation events.
        //   3. A periodic safety interval as a backstop.
        // The button is re-added within one animation frame of any removal.

        const BUTTON_ID = "ytpf-button";
        const BUTTON_CHECK_INTERVAL_MS = 500;
        const POST_INSERT_RECHECK_MS = 250;

        // Selectors are deliberately all scoped under ytd-watch-metadata. Bare
        // IDs like "#flexible-item-buttons" match dozens of elements on a watch
        // page (every video card in the sidebar has one), and we'd risk
        // attaching to a hidden one inside a recommendation tile.
        //
        // Ordered by priority: #top-level-buttons-computed (the like/share row)
        // is the most reliable — always visible, always present.
        // #flexible-item-buttons is YouTube's overflow slot and gets hidden when
        // the row runs out of horizontal space, so it's only a last resort.
        const CONTAINER_SELECTORS = [
            "ytd-watch-metadata #top-level-buttons-computed",
            "ytd-watch-metadata #actions-inner",
            "ytd-watch-metadata #actions",
            "ytd-watch-metadata #flexible-item-buttons",
        ];

        const LIKE_SEGMENT_SELECTORS = [
            "segmented-like-dislike-button-view-model",
            "ytd-segmented-like-dislike-button-renderer",
            "like-button-view-model",
        ].join(", ");

        function isVisible(el) {
            if (!el || !el.isConnected) return false;
            if (el.hidden) return false;
            if (el.offsetParent !== null) return true;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 || rect.height > 0;
        }

        // Returns every connected container, sorted with visible ones first.
        function findCandidateContainers() {
            const seen = new Set();
            const visible = [];
            const hidden = [];
            for (const sel of CONTAINER_SELECTORS) {
                for (const el of document.querySelectorAll(sel)) {
                    if (!el.isConnected || seen.has(el)) continue;
                    seen.add(el);
                    (isVisible(el) ? visible : hidden).push(el);
                }
            }
            return [...visible, ...hidden];
        }

        function buildButton() {
            const btn = document.createElement("button");
            btn.id = BUTTON_ID;
            btn.className = "ytpf-btn";
            btn.title = "Find Playlists";
            btn.appendChild(createPlaylistIcon());
            btn.addEventListener("click", onButtonClick);
            return btn;
        }

        // Insert at the very start of the action row so the button sits on the
        // far left, before the like button.
        function insertButtonInto(container, btn) {
            const like = container.querySelector(LIKE_SEGMENT_SELECTORS);
            if (like) {
                let anchor = like;
                while (anchor.parentElement && anchor.parentElement !== container) {
                    anchor = anchor.parentElement;
                }
                if (anchor.parentElement === container) {
                    anchor.before(btn);
                    return;
                }
            }
            container.prepend(btn);
        }

        function ensureButton() {
            if (location.pathname !== "/watch") {
                document.getElementById(BUTTON_ID)?.remove();
                return;
            }

            const existing = document.getElementById(BUTTON_ID);
            if (existing) {
                if (existing.isConnected
                    && existing.parentElement?.isConnected
                    && isVisible(existing)) {
                    return;
                }
                existing.remove();
            }

            const candidates = findCandidateContainers();
            if (candidates.length === 0) return;

            // Try each candidate, verifying the button is actually visible after
            // insertion. If a container silently swallows our button (e.g. an
            // overflow row with no space), fall through to the next.
            for (const container of candidates) {
                const btn = buildButton();
                insertButtonInto(container, btn);

                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && isVisible(btn)) {
                    // Polymer can hide our button a few frames after insertion
                    // (post-measurement reflow). Re-check shortly so we can fall
                    // through to a different container if that happens.
                    setTimeout(scheduleEnsureButton, POST_INSERT_RECHECK_MS);
                    return;
                }
                btn.remove();
            }
        }

        let ensureScheduled = false;
        function scheduleEnsureButton() {
            if (ensureScheduled) return;
            ensureScheduled = true;
            requestAnimationFrame(() => {
                ensureScheduled = false;
                ensureButton();
            });
        }

        let buttonObserver = null;
        let buttonInterval = null;

        function startButtonWatch() {
            if (!buttonObserver) {
                buttonObserver = new MutationObserver(scheduleEnsureButton);
                buttonObserver.observe(document.body, { childList: true, subtree: true });
            }
            if (buttonInterval == null) {
                buttonInterval = setInterval(ensureButton, BUTTON_CHECK_INTERVAL_MS);
            }
            ensureButton();
        }

        // ===== UI: Modal =====

    function closeModal() {
        if (currentModal) {
            currentModal.remove();
            currentModal = null;
            modalScaffold = null;
            document.body.style.overflow = "";
        }
        if (modalKeyHandler) {
            document.removeEventListener("keydown", modalKeyHandler);
            modalKeyHandler = null;
        }
        // Don't carry filters/searches across modal opens — the next
        // user almost certainly means "show me everything again". The
        // input element itself will be rebuilt on next open via
        // ensureModalScaffold(); we just have to reset the module-level
        // state that drives it.
        searchQuery = "";
    }

        function showModal(pageInfo) {
            closeModal();
            document.body.style.overflow = "hidden";

            const overlay = document.createElement("div");
            overlay.className = "ytpf-overlay";
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) closeModal();
            });

            const modal = document.createElement("div");
            modal.className = "ytpf-modal";

            // Header
            const header = document.createElement("div");
            header.className = "ytpf-header";
            const titleSpan = document.createElement("span");
            titleSpan.className = "ytpf-title";
            titleSpan.textContent = `Playlists \u2014 ${pageInfo.channelName || "Unknown"}`;
            const closeBtn = document.createElement("button");
            closeBtn.className = "ytpf-close";
            closeBtn.title = "Close";
            closeBtn.textContent = "\u00d7";
            closeBtn.addEventListener("click", closeModal);
            header.append(titleSpan, closeBtn);

            // Toolbar
            const toolbar = document.createElement("div");
            toolbar.className = "ytpf-toolbar";
            const btnRefresh = createToolbarBtn("\u27f3 Refresh", "Quick refresh: scan for new/changed playlists and re-verify matches");
            const btnClearCh = createToolbarBtn("Clear Channel", "Wipe this channel's cache and re-fetch everything");
            const btnClearAll = createToolbarBtn("Clear All", "Wipe all cached channel data");
            btnRefresh.addEventListener("click", () => startBackgroundLoad(pageInfo));
            btnClearCh.addEventListener("click", () => {
                cacheDeleteChannel(pageInfo.channelId);
                bgGeneration++;
                bgTask = null;
                logEntries = [];
                closeModal();
            });
            btnClearAll.addEventListener("click", () => {
                if (confirm("Clear all cached playlist data?")) {
                    cacheDeleteAll();
                    bgGeneration++;
                    bgTask = null;
                    logEntries = [];
                    closeModal();
                }
            });
            toolbar.append(btnRefresh, btnClearCh, btnClearAll);

            // Tabs
            const tabs = document.createElement("div");
            tabs.className = "ytpf-tabs";
            const tabMatched = document.createElement("button");
            tabMatched.className = "ytpf-tab" + (activeTab === "matched" ? " ytpf-tab-active" : "");
            tabMatched.id = "ytpf-tab-matched";
            tabMatched.textContent = "Matched (0)";
            tabMatched.addEventListener("click", () => {
                activeTab = "matched";
                searchQuery = "";
                tabMatched.classList.add("ytpf-tab-active");
                tabAll.classList.remove("ytpf-tab-active");
                renderActiveTab();
            });
            const tabAll = document.createElement("button");
            tabAll.className = "ytpf-tab" + (activeTab === "all" ? " ytpf-tab-active" : "");
            tabAll.id = "ytpf-tab-all";
            tabAll.textContent = "All (0)";
            tabAll.addEventListener("click", () => {
                activeTab = "all";
                tabAll.classList.add("ytpf-tab-active");
                tabMatched.classList.remove("ytpf-tab-active");
                renderActiveTab();
            });
            tabs.append(tabMatched, tabAll);

            // Content
            const content = document.createElement("div");
            content.className = "ytpf-content";
            content.id = "ytpf-content";

            // Activity Log
            const logToggle = document.createElement("div");
            logToggle.className = "ytpf-log-toggle";
            logToggle.id = "ytpf-log-toggle";
            logToggle.textContent = "\u25b8 Activity Log";
            const logBody = document.createElement("div");
            logBody.className = "ytpf-log-body";
            logBody.id = "ytpf-log-body";
            logBody.style.display = "none";
            logToggle.addEventListener("click", () => {
                const visible = logBody.style.display !== "none";
                logBody.style.display = visible ? "none" : "block";
                logToggle.textContent = (visible ? "\u25b8" : "\u25be") + " Activity Log";
                if (!visible) logBody.scrollTop = logBody.scrollHeight;
            });

            // Footer
            const footer = document.createElement("div");
            footer.className = "ytpf-footer";
            footer.id = "ytpf-footer";

            modal.append(header, toolbar, tabs, content, logToggle, logBody, footer);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            currentModal = overlay;

        modalKeyHandler = (e) => {
            if (e.key === "Escape") closeModal();
        };
        document.addEventListener("keydown", modalKeyHandler);
    }

        function createToolbarBtn(text, title) {
            const btn = document.createElement("button");
            btn.className = "ytpf-toolbar-btn";
            btn.textContent = text;
            btn.title = title;
            return btn;
        }

        // ===== UI: Playlist Items =====

        // The click handler intentionally re-evaluates playlistContains() at
        // click time rather than capturing it from render time. Items are now
        // updated in-place via updatePlaylistItemState (rather than being
        // rebuilt on every refresh), so a "not matched" item can flip to
        // "matched" while still being the same DOM node.
        function renderPlaylistItem(playlist, videoId) {
            const item = document.createElement("div");
            item.className = "ytpf-playlist-item";
            item.dataset.playlistId = playlist.id;

            const thumb = document.createElement("img");
            thumb.className = "ytpf-thumb";
            thumb.src = playlist.thumbnailUrl;
            thumb.alt = "";
            thumb.loading = "lazy";

            const info = document.createElement("div");
            info.className = "ytpf-info";
            const titleEl = document.createElement("div");
            titleEl.className = "ytpf-pl-title";
            titleEl.title = playlist.title;
            titleEl.textContent = playlist.title;
            const countEl = document.createElement("div");
            countEl.className = "ytpf-pl-count";
            countEl.textContent = `${playlist.videoCount} video${playlist.videoCount !== 1 ? "s" : ""}`;
            info.append(titleEl, countEl);

            const indicator = document.createElement("div");
            indicator.className = "ytpf-indicator";

            item.append(thumb, info, indicator);

            item.addEventListener("click", () => {
                if (playlistContains(playlist, videoId)) {
                    window.location.href = `/watch?v=${videoId}&list=${playlist.id}`;
                } else {
                    window.location.href = `/playlist?list=${playlist.id}`;
                }
            });

            return item;
        }

        // Updates an existing playlist item's indicator and "contains video"
        // border in place. Called from the reconciler so most refreshes touch
        // only one DOM property per item, instead of rebuilding hundreds of
        // nodes from scratch.
        function updatePlaylistItemState(item, pl, videoId, loading) {
            const containsVideo = playlistContains(pl, videoId);
            const notChecked = pl.videoIds === null;

            if (item._ytpfContains !== containsVideo) {
                item.classList.toggle("ytpf-contains-video", containsVideo);
                item._ytpfContains = containsVideo;
            }

            const desiredState = containsVideo ? "match"
                : notChecked && loading ? "loading"
                : notChecked ? "pending"
                : "checked-empty";

            if (item._ytpfState === desiredState) return;
            item._ytpfState = desiredState;

            const indicator = item.querySelector(".ytpf-indicator");
            if (!indicator) return;
            clearChildren(indicator);
            indicator.style.color = "";
            if (desiredState === "match") {
                indicator.textContent = "\u2713";
            } else if (desiredState === "loading") {
                indicator.appendChild(createSpinner());
            } else if (desiredState === "checked-empty") {
                indicator.textContent = "\u25cb";
                indicator.style.color = "#555";
            }
        }

        // ===== Tab Rendering =====

        // Caches a Set of videoIds per playlist (in-memory only, not persisted
        // to GM storage). videoIds itself can be a few thousand entries;
        // Array.includes is O(n), and the Matched filter + updateTabCounts
        // call it once per playlist per render — that's O(playlists *
        // avgVideos) per render, which is the second hot path (after
        // refresh-per-iteration) on cached re-opens.
        //
        // Stored in a WeakMap rather than on the playlist object so the cache
        // doesn't leak through GM_setValue's JSON serialization (a Set would
        // round-trip as {} and silently corrupt later lookups).
        const playlistVideoIdSets = new WeakMap();
        function playlistContains(pl, videoId) {
            if (!pl || !pl.videoIds || !videoId) return false;
            let entry = playlistVideoIdSets.get(pl);
            if (!entry || entry.size !== pl.videoIds.length) {
                entry = { size: pl.videoIds.length, set: new Set(pl.videoIds) };
                playlistVideoIdSets.set(pl, entry);
            }
            return entry.set.has(videoId);
        }

        // O(1) read of bgTask counters maintained incrementally by the worker
        // and recomputeBgTaskCounters(). Avoids re-scanning all playlists on
        // every refresh during fetching.
        function updateTabCounts() {
            if (!bgTask) return;
            const tabM = document.getElementById("ytpf-tab-matched");
            const tabA = document.getElementById("ytpf-tab-all");
            const matchedText = `Matched (${bgTask.matchedCount || 0})`;
            const allText = `All (${bgTask.playlists.length})`;
            if (tabM && tabM.textContent !== matchedText) tabM.textContent = matchedText;
            if (tabA && tabA.textContent !== allText) tabA.textContent = allText;
        }

        const SORT_LABELS = {
            "az": "A\u2192Z",
            "za": "Z\u2192A",
            "count-desc": "Most videos",
            "count-asc": "Fewest videos",
            "updated-desc": "Recently updated",
            "updated-asc": "Oldest update",
        };
        const SORT_CYCLE = ["az", "za", "count-desc", "count-asc", "updated-desc", "updated-asc"];

        // Builds the persistent content scaffold once (filter bar, empty
        // message slot, list container). Returns existing scaffold on
        // subsequent calls. The scaffold is reset in closeModal().
        function ensureModalScaffold() {
            if (modalScaffold && modalScaffold.listContainer.isConnected) return modalScaffold;

            const content = document.getElementById("ytpf-content");
            if (!content) return null;
            clearChildren(content);

            const filterBar = document.createElement("div");
            filterBar.className = "ytpf-filter-bar";
            filterBar.style.display = "none";

            const searchInput = document.createElement("input");
            searchInput.className = "ytpf-search";
            searchInput.type = "text";
            searchInput.placeholder = "Search playlists\u2026";
            searchInput.addEventListener("input", (e) => {
                searchQuery = e.target.value;
                renderActiveTab();
            });

            const sortBtn = document.createElement("button");
            sortBtn.className = "ytpf-sort-btn";
            sortBtn.title = "Change sort order";
            sortBtn.addEventListener("click", () => {
                const idx = SORT_CYCLE.indexOf(allSortMode);
                allSortMode = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
                renderActiveTab();
            });

            filterBar.append(searchInput, sortBtn);

            const emptyMsg = document.createElement("div");
            emptyMsg.className = "ytpf-empty";
            emptyMsg.style.display = "none";

            const listContainer = document.createElement("div");
            listContainer.className = "ytpf-list";

            content.append(filterBar, emptyMsg, listContainer);

            modalScaffold = { filterBar, emptyMsg, listContainer, searchInput, sortBtn };
            return modalScaffold;
        }

        // Updates the empty/info message in place. Avoids creating a new node
        // on every render (which would otherwise destroy the spinner mid-frame
        // and cause flicker).
        function setEmptyMessage(scaffold, message, withSpinner) {
            scaffold.emptyMsg.style.display = "";
            scaffold.listContainer.style.display = "none";
            const desiredKey = (withSpinner ? "s:" : "t:") + message;
            if (scaffold.emptyMsg._ytpfKey === desiredKey) return;
            scaffold.emptyMsg._ytpfKey = desiredKey;
            clearChildren(scaffold.emptyMsg);
            if (withSpinner) {
                scaffold.emptyMsg.appendChild(createSpinner());
                scaffold.emptyMsg.append(" " + message);
            } else {
                scaffold.emptyMsg.textContent = message;
            }
        }

        // Reconciles the list container's children with `desired` by
        // data-playlist-id. Existing nodes are moved/updated in place; only
        // new playlists trigger DOM creation, only removed playlists trigger
        // DOM deletion. This is the key fix: previously every refresh did
        // clearChildren + 500 createElements, which wiped scroll position and
        // burned thousands of allocations per second.
        function reconcileList(container, desired, videoId, loading) {
            const current = new Map();
            for (const child of Array.from(container.children)) {
                const id = child.dataset?.playlistId;
                if (id) current.set(id, child);
                else child.remove();
            }

            const desiredIds = new Set();
            for (const pl of desired) desiredIds.add(pl.id);

            for (const [id, el] of current) {
                if (!desiredIds.has(id)) {
                    el.remove();
                    current.delete(id);
                }
            }

            for (let i = 0; i < desired.length; i++) {
                const pl = desired[i];
                const target = container.children[i] || null;

                if (target && target.dataset.playlistId === pl.id) {
                    updatePlaylistItemState(target, pl, videoId, loading);
                    continue;
                }

                let item = current.get(pl.id);
                if (!item) {
                    item = renderPlaylistItem(pl, videoId);
                    current.set(pl.id, item);
                }
                container.insertBefore(item, target);
                updatePlaylistItemState(item, pl, videoId, loading);
            }
        }

        function renderActiveTab() {
            if (!bgTask) return;
            const scaffold = ensureModalScaffold();
            if (!scaffold) return;

            const loading = isBackgroundLoading();

            if (activeTab === "matched") {
                scaffold.filterBar.style.display = "none";

                // Build the matched list directly. Cheap because matchedCount
                // is small (just the matches), not the full ~500 playlists.
                const matched = [];
                for (const pl of bgTask.playlists) {
                    if (playlistContains(pl, bgTask.videoId)) matched.push(pl);
                }
                matched.sort((a, b) => a.videoCount - b.videoCount);

                if (matched.length === 0) {
                    const totalChecked = bgTask.checkedCount || 0;
                    const total = bgTask.playlists.length;
                    if (total > 0 && totalChecked >= total) {
                        setEmptyMessage(scaffold, "No playlists contain this video.", false);
                    } else if (total > 0) {
                        setEmptyMessage(scaffold, "Checking playlists\u2026", true);
                    } else {
                        setEmptyMessage(scaffold, "Loading\u2026", true);
                    }
                    return;
                }

                scaffold.emptyMsg.style.display = "none";
                scaffold.listContainer.style.display = "";
                reconcileList(scaffold.listContainer, matched, bgTask.videoId, loading);
                return;
            }

            // All tab
            scaffold.filterBar.style.display = "";
            if (scaffold.searchInput.value !== searchQuery) {
                scaffold.searchInput.value = searchQuery;
            }
            if (scaffold.sortBtn.textContent !== SORT_LABELS[allSortMode]) {
                scaffold.sortBtn.textContent = SORT_LABELS[allSortMode];
            }

            let playlists = bgTask.playlists;
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                playlists = playlists.filter(pl => pl.title.toLowerCase().includes(q));
            } else {
                playlists = playlists.slice();
            }

            if (allSortMode === "az") {
                playlists.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
            } else if (allSortMode === "za") {
                playlists.sort((a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" }));
            } else if (allSortMode === "count-desc") {
                playlists.sort((a, b) => b.videoCount - a.videoCount);
            } else if (allSortMode === "count-asc") {
                playlists.sort((a, b) => a.videoCount - b.videoCount);
            } else if (allSortMode === "updated-desc") {
                // Items missing lastUpdated sink to the bottom so we don't
                // claim "recently updated" for things we don't have data on.
                playlists.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
            } else {
                playlists.sort((a, b) => (a.lastUpdated || Infinity) - (b.lastUpdated || Infinity));
            }

            if (playlists.length === 0) {
                if (loading && bgTask.playlists.length === 0) {
                    setEmptyMessage(scaffold, "Loading playlists\u2026", true);
                } else if (searchQuery) {
                    setEmptyMessage(scaffold, "No playlists match your search.", false);
                } else {
                    setEmptyMessage(scaffold, "This channel has no playlists.", false);
                }
                return;
            }

            scaffold.emptyMsg.style.display = "none";
            scaffold.listContainer.style.display = "";
            reconcileList(scaffold.listContainer, playlists, bgTask.videoId, loading);
        }

        function updateFooter() {
            const footer = document.getElementById("ytpf-footer");
            if (!footer || !bgTask) return;

            const total = bgTask.playlists.length;
            const checked = bgTask.checkedCount || 0;

            let text;
            if (bgTask.done || (total > 0 && checked >= total)) {
                const when = new Date().toLocaleString();
                text = `${total} playlist${total !== 1 ? "s" : ""} \u00b7 Last checked: ${when}`;
            } else if (total > 0) {
                text = `Checking playlists\u2026 ${checked} / ${total}`;
            } else {
                text = "Loading\u2026";
            }
            if (footer.textContent !== text) footer.textContent = text;
        }

        function refreshUI() {
            if (!currentModal) return;
            updateTabCounts();
            renderActiveTab();
            updateFooter();
        }

        // Recomputes bgTask.checkedCount and bgTask.matchedCount from
        // scratch. Used after any structural change to bgTask.playlists
        // (cache load, channel-page fetch). The worker maintains the
        // counters incrementally between recomputes.
        function recomputeBgTaskCounters() {
            if (!bgTask) return;
            let checked = 0, matched = 0;
            for (const pl of bgTask.playlists) {
                if (pl.videoIds !== null && pl.videoIds !== undefined) checked++;
                if (playlistContains(pl, bgTask.videoId)) matched++;
            }
            bgTask.checkedCount = checked;
            bgTask.matchedCount = matched;
        }

        // Coalesces bursts of refresh calls into a single render per frame.
        // The streaming worker pool can fire many scheduleRefreshUI calls in
        // quick succession (one per processed playlist, plus one per phase 1
        // batch arrival), and refreshUI() is O(N) in playlists, so refreshing
        // per-iteration would be quadratic and freeze the modal.
        let refreshScheduled = false;
        function scheduleRefreshUI() {
            if (refreshScheduled) return;
            refreshScheduled = true;
            requestAnimationFrame(() => {
                refreshScheduled = false;
                refreshUI();
            });
        }

        // ===== Background Loading =====

        function saveBgTaskToCache() {
            if (!bgTask) return;
            cacheSet(bgTask.channelId, {
                channelId: bgTask.channelId,
                channelName: bgTask.pageInfo.channelName,
                playlists: bgTask.playlists,
                // Persisted so subsequent quick refreshes can hit the
                // sorted browse endpoint directly without re-discovering
                // the param from a default channel-page fetch.
                sortParamLastVideoAdded: bgTask.sortParamLastVideoAdded || null,
                // Whether we've ever fully paginated the channel's
                // playlist tab in this task. Mid-streaming saves
                // serialize this as false; only a successful
                // fetchChannelPlaylists flips it to true. On reload, a
                // false value forces fullEnumeration on the next quick
                // refresh so an interrupted previous run can't leave
                // playlists permanently invisible.
                enumerated: bgTask.enumerated === true,
            });
        }

        // Streaming worker pool that consumes playlists from a producer.
        //
        // The producer is given an `enqueue(pl, prevState)` function. Each
        // enqueued playlist gets fetched fresh by a worker, which then
        // applies a *delta* to bgTask.checkedCount / matchedCount based
        // on the supplied prevState versus the freshly-determined match
        // state. This is what lets us:
        //   - re-verify cached matches without double-counting them
        //     (prevState="matched"; if the fetch confirms the match the
        //     count is unchanged, if it denies the match the count drops)
        //   - fill in incomplete cache entries (prevState="uncounted";
        //     count rises by 1 when fetched)
        //   - re-fetch playlists that have changed since cache, whether
        //     they were matches before or not
        //
        // Items NOT enqueued are left as-is; the caller is expected to have
        // already counted them via recomputeBgTaskCounters() if applicable.
        //
        // Phase 1 (channel-page enumeration) and phase 2 (per-playlist
        // videoId fetches) pipeline naturally: workers start consuming the
        // moment the first batch arrives from the producer, so phase 1's
        // wall-clock time is absorbed into phase 2's.
    async function processPlaylistsStreaming(pageInfo, gen, producer) {
        if (!bgTask) return;

        const queue = [];
        const queuedIds = new Set();
        let producerDone = false;
        const waiters = [];

        // Periodic-save throttle. Counts EVERY processed item (verifications
        // included), independent of bgTask.checkedCount — which only bumps for
        // "uncounted" prevStates and so can't be used as a save trigger:
        //   - sitting on a multiple of 10 during a verification burst caused
        //     a save on every iteration (50+ saves for 50 verifications), and
        //   - sitting on a non-multiple meant verifications were never
        //     persisted at all until the final post-streaming save.
        // A simple counter keyed off the loop is correct in both cases.
        const SAVE_EVERY_N_ITEMS = 15;
        let itemsProcessedSinceSave = 0;

            function wakeOne() {
                const w = waiters.shift();
                if (w) w();
            }
            function wakeAll() {
                while (waiters.length > 0) waiters.shift()();
            }

            // Idempotent — a playlist enqueued twice (e.g. once as a
            // cached match, once via quick-refresh discovering it modified)
            // is only processed once. The earliest-supplied prevState wins,
            // which is the correct one (it reflects the state before any
            // worker mutation).
            function enqueue(pl, prevState) {
                if (bgGeneration !== gen || !bgTask) return;
                if (queuedIds.has(pl.id)) return;
                queuedIds.add(pl.id);
                queue.push({ pl, prevState });
                wakeOne();
            }

            async function processOne(pl, prevState) {
                let result = null, errMsg = null;
                try {
                    if (CONFIG.FETCH_DELAY_MS > 0) await sleep(CONFIG.FETCH_DELAY_MS);
                    if (bgGeneration !== gen) return;
                    result = await fetchPlaylistVideoIds(pl.id, pageInfo.videoId);
                } catch (e) {
                    errMsg = e.message;
                }

                if (bgGeneration !== gen || !bgTask) return;

                const totalNow = bgTask.playlists.length;
                if (errMsg) {
                    // Don't bump checkedCount on errors. The previous
                    // logic incremented it for "uncounted" so the footer
                    // could reach total, but that desynced the in-memory
                    // counter from what recomputeBgTaskCounters would
                    // give on the next reload (which only counts
                    // playlists with non-null videoIds). Better to leave
                    // the counter accurate — the footer can still finish
                    // because the rest of the queue still progresses.
                    modalLog(`[${bgTask.checkedCount}/${totalNow}] "${pl.title}" \u2014 error: ${errMsg}`);
                } else {
                    pl.videoIds = result.videoIds;
                    pl.lastChecked = Date.now();
                    playlistVideoIdSets.delete(pl);

                    const newState = result.containsTarget ? "matched" : "not-matched";

                    // Apply state-transition delta. Truth table:
                    //   uncounted    -> matched      checked+1, matched+1
                    //   uncounted    -> not-matched  checked+1
                    //   matched      -> matched      (no change)
                    //   matched      -> not-matched  matched-1   (was over-counted from cache)
                    //   not-matched  -> matched      matched+1   (newly matched)
                    //   not-matched  -> not-matched  (no change)
                    if (prevState === "uncounted") {
                        bgTask.checkedCount++;
                        if (newState === "matched") bgTask.matchedCount++;
                    } else if (prevState === "matched" && newState === "not-matched") {
                        // Math.max guard: should never go negative under
                        // correct delta accounting, but defensively clamp
                        // so a future bug can't render "Matched (-1)".
                        bgTask.matchedCount = Math.max(0, bgTask.matchedCount - 1);
                    } else if (prevState === "not-matched" && newState === "matched") {
                        bgTask.matchedCount++;
                    }

                    const tag = newState === "matched" ? " \u2605 MATCH" : "";
                    let extra = "";
                    if (prevState === "matched" && newState === "not-matched") extra = " (was match \u2014 removed from playlist)";
                    else if (prevState === "not-matched" && newState === "matched") extra = " (newly matched)";
                    modalLog(`[${bgTask.checkedCount}/${totalNow}] "${pl.title}" \u2014 ${result.videoIds.length} videos${tag}${extra}`);
                }

            scheduleRefreshUI();

            itemsProcessedSinceSave++;
            if (itemsProcessedSinceSave >= SAVE_EVERY_N_ITEMS) {
                itemsProcessedSinceSave = 0;
                saveBgTaskToCache();
            }
        }

            async function worker() {
                while (bgGeneration === gen) {
                    const item = queue.shift();
                    if (item) {
                        await processOne(item.pl, item.prevState);
                        continue;
                    }
                    if (producerDone) break;
                    await new Promise(resolve => waiters.push(resolve));
                }
            }

            // Start the pool first. Workers idle on the empty queue until
            // the producer enqueues items.
            const workers = [];
            for (let w = 0; w < CONFIG.PARALLEL_FETCHES; w++) {
                workers.push(worker());
            }

            let producerError = null;
            try {
                await producer(enqueue);
            } catch (e) {
                producerError = e;
            } finally {
                producerDone = true;
                wakeAll();
            }

            await Promise.all(workers);

            if (producerError) throw producerError;
        }

        // Returns the prevState ("uncounted" | "matched" | "not-matched")
        // for a playlist as it currently sits in cache. Used so the worker
        // knows whether each item was already counted in
        // bgTask.checkedCount/matchedCount before it was enqueued.
        function cachedPrevState(pl) {
            if (!pl.videoIds || !pl.lastChecked) return "uncounted";
            return playlistContains(pl, bgTask.videoId) ? "matched" : "not-matched";
        }

    // Quick refresh: re-fetch the channel/playlists page sorted by
    // "Last video added" and stop pagination as soon as we find a
    // playlist that hasn't been updated since `cached.lastChecked`.
    // New or modified playlists are enqueue()'d for a videoIds fetch;
    // unchanged playlists are not touched.
    //
    // Falls back to full unsorted pagination (no early-stop) if the
    // sort param can't be obtained.
    //
    // opts.fullEnumeration: when true, disables the early-stop heuristic
    //   even on the sorted path. We use this when the cache is
    //   structurally incomplete (a previous fetch was interrupted before
    //   phase 1 finished enumerating the channel), because in that case
    //   `cached.lastChecked` reflects a partial-save timestamp, not a
    //   real "we saw the whole channel at this time" mark — so stopping
    //   early on it can leave un-enumerated playlists permanently
    //   missing from our list.
    async function runQuickRefresh(pageInfo, gen, cached, enqueue, opts = {}) {
        const fullEnum = opts.fullEnumeration === true;
        const T = cached.lastChecked || 0;
        let stopReached = false;
        let scannedCount = 0;

        // O(1) lookup of existing playlists by id. Replaces an O(n) Array.find
        // per processed item (which was O(n²) overall on channels with
        // hundreds of playlists). Mutated in lock-step with bgTask.playlists.
        const existingById = new Map();
        for (const pl of bgTask.playlists) existingById.set(pl.id, pl);

            // processBatch is shared between sorted and unsorted paths.
            // The `allowEarlyStop` flag is only set in sorted mode where
            // hitting an "unchanged" playlist guarantees all later
            // playlists are also unchanged.
        const processBatch = (batch, allowEarlyStop) => {
            if (bgGeneration !== gen || !bgTask) return;
            for (const pl of batch) {
                scannedCount++;
                const existing = existingById.get(pl.id);
                if (!existing) {
                    // Brand-new playlist that wasn't in cache. Add it
                    // and queue for a fresh videoIds fetch.
                    const merged = { ...pl, videoIds: null, lastChecked: null };
                    bgTask.playlists.push(merged);
                    existingById.set(merged.id, merged);
                    enqueue(merged, "uncounted");
                } else {
                    // Update the metadata fields that come from the
                    // channel page (title, thumbnail, videoCount,
                    // lastUpdated) but preserve videoIds / lastChecked.
                    // lastUpdated is preserved when the new fetch couldn't
                    // parse one — overwriting a known-good timestamp with
                    // null on a transient parse failure would silently
                    // demote the playlist on future quick-refresh cutoff
                    // comparisons.
                    const prevVideoIds = existing.videoIds;
                    const prevLastChecked = existing.lastChecked;
                    const prevLastUpdated = existing.lastUpdated;
                    const prevVideoCount = existing.videoCount;
                    Object.assign(existing, pl, {
                        videoIds: prevVideoIds,
                        lastChecked: prevLastChecked,
                        lastUpdated: pl.lastUpdated != null ? pl.lastUpdated : prevLastUpdated,
                    });

                    // null lastUpdated → unparseable string. We can't
                    // tell whether the playlist is newer or older than
                    // our cache, so we don't act on it: don't refetch
                    // (trust the cache), and don't stop pagination
                    // (keep looking for a confidently-older item).
                    const lastUpdatedKnown = pl.lastUpdated != null && pl.lastUpdated > 0;
                    const newer = lastUpdatedKnown && pl.lastUpdated > T;

                    // Removals don't bump "Last video added", but they
                    // do change videoCount. Catching count drift here
                    // refetches such playlists inside the early-stop
                    // window, narrowing the "deleted videos linger"
                    // failure mode without changing the early-stop
                    // semantics (which still depend solely on
                    // lastUpdated to be sound).
                    const countChanged = pl.videoCount > 0
                        && prevVideoCount > 0
                        && pl.videoCount !== prevVideoCount;

                    if ((newer || countChanged) && existing.videoIds && existing.lastChecked) {
                        // Modified existing playlist: re-fetch.
                        enqueue(existing, cachedPrevState(existing));
                    } else if (lastUpdatedKnown && !newer && allowEarlyStop) {
                        // Sorted-by-lastUpdated and we've hit something
                        // confidently older than our cache → all later
                        // items are even older. Stop pagination and skip
                        // the rest of this batch (they're all guaranteed
                        // older too).
                        stopReached = true;
                        break;
                    }
                }
            }
            scheduleRefreshUI();
        };

            // Try to get the "Last video added" sort param. We cache it on
            // the bgTask once learned so a subsequent quick refresh on this
            // channel doesn't pay the discovery cost.
            let sortParam = cached.sortParamLastVideoAdded || null;
            let initialDataForFallback = null;

            if (!sortParam) {
                try {
                    const res = await fetch(`/channel/${pageInfo.channelId}/playlists`);
                    // The fetch can take a long time; the user may have
                    // navigated to another channel by the time it
                    // resolves. Bail before touching bgTask, which now
                    // points at a different channel's task and would
                    // otherwise get the wrong (opaque, per-channel)
                    // sortParam written into it.
                    if (bgGeneration !== gen || !bgTask) return;
                    if (res.ok) {
                        initialDataForFallback = extractYtInitialData(await res.text());
                        if (bgGeneration !== gen || !bgTask) return;
                        const sortMap = findSortParamsByLabel(initialDataForFallback);
                        sortParam = pickSortParam(sortMap, ["last video added", "last updated", "recently updated"]);
                        if (sortParam) {
                            bgTask.sortParamLastVideoAdded = sortParam;
                        }
                    }
                } catch (_) {}
            }

        if (sortParam) {
            if (bgGeneration !== gen || !bgTask) return;
            bgTask.sortParamLastVideoAdded = sortParam;
            modalLog(fullEnum
                ? "Refresh: full re-enumeration (cache was incomplete)\u2026"
                : "Quick refresh: scanning channel for changes\u2026");
            await fetchChannelPlaylists(pageInfo.channelId, (batch) => {
                processBatch(batch, !fullEnum);
            }, {
                sortParam,
                shouldStop: fullEnum ? undefined : () => stopReached,
            });
        } else if (initialDataForFallback) {
                // Sort param unavailable but we already pulled the default
                // page. Reuse it to start unsorted pagination.
                modalLog("Quick refresh: scanning channel (unsorted fallback)\u2026");
                const initialBatch = findPlaylistRenderers(initialDataForFallback)
                    .map(parsePlaylistRenderer)
                    .filter(Boolean);
                if (initialBatch.length > 0) processBatch(initialBatch, false);

                // Continuation errors propagate so the caller can mark
                // the cache as not-fully-enumerated. Silent break here
                // would let an interrupted scan persist as if it
                // covered everything.
                let token = findContinuationToken(initialDataForFallback);
                while (token && bgGeneration === gen && bgTask) {
                    if (CONFIG.FETCH_DELAY_MS > 0) await sleep(CONFIG.FETCH_DELAY_MS);
                    const data = await innerTubeBrowse(token);
                    if (bgGeneration !== gen || !bgTask) return;
                    const newRenderers = [];
                    for (const action of (data.onResponseReceivedActions || [])) {
                        findPlaylistRenderers(action.appendContinuationItemsAction?.continuationItems || [], newRenderers);
                    }
                    const batch = newRenderers.map(parsePlaylistRenderer).filter(Boolean);
                    if (batch.length > 0) processBatch(batch, false);
                    token = findContinuationToken(data);
                }
            } else {
                // Last-resort: re-fetch the channel page from scratch and
                // paginate unsorted.
                modalLog("Quick refresh: scanning channel (unsorted)\u2026");
                await fetchChannelPlaylists(pageInfo.channelId, (batch) => {
                    processBatch(batch, false);
                });
            }

            if (bgGeneration !== gen || !bgTask) return;

            // Only log a final "scanned X" summary, not one per batch.
            // Per-batch logging filled the activity log with redundant
            // updates on big channels.
            modalLog(`Refresh: scanned ${scannedCount} playlist${scannedCount !== 1 ? "s" : ""}${stopReached ? " (early-stop)" : ""}`);

            // Mark the task as having seen a complete enumeration of the
            // channel. The cache will persist this so the next visit
            // knows it can rely on early-stop. If we threw on the way
            // here (network error mid-pagination), this line is skipped
            // and the cached `enumerated: false` from the partial save
            // forces a full re-pagination next time.
            bgTask.enumerated = true;
        }

        // Loads playlists for the current page into bgTask.
        //
        // Called exactly once per page load: when the user first clicks
        // the button (onButtonClick) or hits the in-modal Refresh button.
        // Subsequent button clicks on the same channel+video just reopen
        // the modal against the existing bgTask (no reload).
        //
        // Cached path: load cache, re-verify matches, fill incomplete
        //   entries, then run a quick refresh against the channel page
        //   to detect any new/changed playlists. There is no TTL — the
        //   quick refresh always runs on first load. (One channel-page
        //   fetch is cheap enough that gating it on a TTL was not worth
        //   the staleness risk.)
        // Full fetch path: no cache → enumerate everything from scratch.
        //
        // Phase 1 (channel-page enumeration) and phase 2 (per-playlist
        // videoIds fetches) pipeline through processPlaylistsStreaming:
        // workers start consuming items the moment phase 1 emits them.
        async function startBackgroundLoad(pageInfo) {
            const gen = ++bgGeneration;
            logEntries = [];

            bgTask = {
                channelId: pageInfo.channelId,
                videoId: pageInfo.videoId,
                generation: gen,
                playlists: [],
                pageInfo,
                done: false,
                checkedCount: 0,
                matchedCount: 0,
                sortParamLastVideoAdded: null,
                // True only after a successful fetchChannelPlaylists.
                // Persisted in cache so the next visit knows whether the
                // previous enumeration completed (and therefore whether
                // it can rely on early-stop in quick refresh).
                enumerated: false,
            };

            activeTab = "matched";
            searchQuery = "";
            const tabM = document.getElementById("ytpf-tab-matched");
            const tabA = document.getElementById("ytpf-tab-all");
            if (tabM) tabM.classList.add("ytpf-tab-active");
            if (tabA) tabA.classList.remove("ytpf-tab-active");

            refreshUI();
            rebuildLogPanel();

            modalLog(`Loading playlists for ${pageInfo.channelName || pageInfo.channelId}\u2026`);

            const cached = cacheGet(pageInfo.channelId);

            // ===== Cached path =====
            //
            // Cache exists. Goals, executed in parallel via the streaming
            // worker pool:
            //   1. Re-verify cached matches (catches videos removed from
            //      a playlist; YouTube's "Last video added" timestamp may
            //      not bump on removal, so cache alone can't detect it).
            //   2. Fill any incomplete cache entries (videoIds === null).
            //   3. Quick-refresh: paginate the channel sorted by
            //      "Last video added", enqueue any new or recently-
            //      modified playlists, and stop the moment we hit one
            //      unchanged since cache.lastChecked.
            //
            // Everything else (cached non-matches that haven't been
            // touched since our cache) is left exactly as-is and stays
            // counted via recomputeBgTaskCounters.
            if (cached?.playlists && Array.isArray(cached.playlists)) {
                // Normalize legacy / partially-broken cache entries so
                // the rest of the code can rely on the documented shape:
                //   videoIds: null | string[]
                //   lastChecked: null | number
                // Older versions sometimes wrote `undefined` (which
                // doesn't survive JSON round-tripping but can leak in
                // from manually edited caches) which was making
                // updatePlaylistItemState briefly mis-render the
                // indicator on the first frame after load.
                for (const pl of cached.playlists) {
                    if (pl.videoIds === undefined) pl.videoIds = null;
                    if (pl.lastChecked === undefined) pl.lastChecked = null;
                }

                bgTask.playlists = cached.playlists;
                bgTask.sortParamLastVideoAdded = cached.sortParamLastVideoAdded || null;
                // Carry the persisted enumerated flag forward so
                // mid-streaming saves don't immediately stomp it back
                // to false. Default to true on legacy caches without
                // the field — they predate the flag and are assumed
                // complete.
                bgTask.enumerated = cached.enumerated !== false;
                recomputeBgTaskCounters();
                modalLog(`Loaded ${cached.playlists.length} playlists from cache (${bgTask.matchedCount} match${bgTask.matchedCount !== 1 ? "es" : ""})`);
                refreshUI();

                // !allChecked → a previous fetch was interrupted before
                // every playlist's videoIds had been recorded.
                // !cached.enumerated → a previous fetch was interrupted
                // mid-channel-page-enumeration. Either condition makes
                // cache.lastChecked an unreliable cutoff for early-stop,
                // so we force fullEnumeration to re-pull the entire
                // channel page.
                const total = cached.playlists.length;
                const allChecked = total > 0 && bgTask.checkedCount >= total;
                const cacheIncomplete = !allChecked || !bgTask.enumerated;

                try {
                    await processPlaylistsStreaming(pageInfo, gen, async (enqueue) => {
                        // Step 1: enqueue cached matches and incompletes
                        // immediately so workers start fetching them
                        // before quick refresh has even hit the network.
                        // Match verification therefore happens ASAP.
                        for (const pl of bgTask.playlists) {
                            const ps = cachedPrevState(pl);
                            if (ps === "uncounted") {
                                enqueue(pl, "uncounted");
                            } else if (ps === "matched") {
                                enqueue(pl, "matched");
                            }
                            // ps === "not-matched" → leave alone. It was
                            // already counted by recomputeBgTaskCounters
                            // and the quick-refresh below may yet
                            // enqueue it if it turns out to have been
                            // modified.
                        }

                        // Step 2: quick refresh always runs. The wall-
                        // clock cost is one channel-page fetch + a small
                        // continuation tail (early-stop kicks in fast),
                        // and it pipelines with the verifies already
                        // being processed by the worker pool.
                        await runQuickRefresh(pageInfo, gen, cached, enqueue, {
                            fullEnumeration: cacheIncomplete,
                        });
                    });
                    if (bgGeneration !== gen) return;
                    bgTask.done = true;
                    saveBgTaskToCache();
                    modalLog(`Done. ${bgTask.matchedCount} playlist${bgTask.matchedCount !== 1 ? "s" : ""} contain this video.`);
                    refreshUI();
                } catch (e) {
                    showLoadError(gen, pageInfo, e);
                }
                return;
            }

            // ===== Full fetch path =====
            //
            // No cache exists for this channel (first visit, or user just
            // hit Clear Channel). Phase 1 (fetchChannelPlaylists) emits
            // each discovered playlist into the worker pool as the
            // channel page paginates, so phase 2 (per-playlist videoId
            // fetches) starts running while phase 1 is still in flight.
            try {
                bgTask.playlists = [];
                refreshUI();
                modalLog("Fetching channel playlists\u2026");

                // O(1) duplicate guard for the per-batch callback. The
                // renderer sometimes reports the same playlist in a
                // later page (e.g. when a "shelf" repeats it), and a
                // per-pl Array.find here was O(n²) overall on large
                // channels.
                const seenIds = new Set();
                await processPlaylistsStreaming(pageInfo, gen, async (enqueue) => {
                    const result = await fetchChannelPlaylists(pageInfo.channelId, (batch) => {
                        if (bgGeneration !== gen || !bgTask) return;
                        for (const pl of batch) {
                            if (seenIds.has(pl.id)) continue;
                            seenIds.add(pl.id);
                            const merged = { ...pl, videoIds: null, lastChecked: null };
                            bgTask.playlists.push(merged);
                            enqueue(merged, "uncounted");
                        }
                        modalLog(`Found ${bgTask.playlists.length} playlists so far\u2026`);
                        scheduleRefreshUI();
                    }, { returnInitialData: true });

                    if (bgGeneration !== gen || !bgTask) return;

                    // Capture the sort param for next time's quick refresh.
                    if (result?.initialData) {
                        const sortMap = findSortParamsByLabel(result.initialData);
                        const sp = pickSortParam(sortMap, ["last video added", "last updated", "recently updated"]);
                        if (sp) bgTask.sortParamLastVideoAdded = sp;
                    }
                    // Reaching this point means fetchChannelPlaylists
                    // resolved without throwing → enumeration is
                    // reliable. (If a continuation request had failed
                    // it would have thrown all the way up here and we'd
                    // skip this assignment, leaving enumerated=false so
                    // next visit forces a full re-pagination.)
                    bgTask.enumerated = true;
                });

                if (bgGeneration !== gen) return;

                if (bgTask.playlists.length === 0) {
                    bgTask.done = true;
                    saveBgTaskToCache();
                    modalLog("This channel has no playlists.");
                    refreshUI();
                    return;
                }

                bgTask.done = true;
                saveBgTaskToCache();
                modalLog(`Done. ${bgTask.matchedCount} playlist${bgTask.matchedCount !== 1 ? "s" : ""} contain this video.`);
                refreshUI();
            } catch (e) {
                showLoadError(gen, pageInfo, e);
            }
        }

        function showLoadError(gen, pageInfo, e) {
            // The whole function is a no-op for superseded tasks. We
            // previously logged the error and rebuilt the modal's
            // content unconditionally, which could render the OLD
            // task's error UI on top of a NEW task that the user just
            // started (e.g. via the Refresh button) — making the modal
            // look like the new fetch failed.
            if (bgGeneration !== gen) return;

            modalLog(`Error: ${e.message}`);
            if (bgTask) {
                bgTask.done = true;
                if (bgTask.playlists.length > 0) saveBgTaskToCache();
            }
            if (!currentModal) return;
            const content = document.getElementById("ytpf-content");
            if (!content) return;
            clearChildren(content);
            modalScaffold = null;
            const errorDiv = document.createElement("div");
            errorDiv.className = "ytpf-error";
            errorDiv.append("Failed to load playlists. ");
            const retryBtn = document.createElement("button");
            retryBtn.className = "ytpf-retry";
            retryBtn.textContent = "Retry";
            retryBtn.addEventListener("click", () => startBackgroundLoad(pageInfo));
            errorDiv.appendChild(retryBtn);
            content.appendChild(errorDiv);
        }

        // ===== Main Entry Point =====

        // Invoked by the in-page button AND by the Tampermonkey menu command,
        // so it has to handle the case where the user isn't on a video page.
        async function onButtonClick() {
            if (currentModal) { closeModal(); return; }

            if (location.pathname !== "/watch") {
                alert("Open a YouTube video first to use YT Playlist Finder.");
                return;
            }

            const pageInfo = getPageInfo();
            if (!pageInfo.videoId || !pageInfo.channelId) {
                alert("Couldn't read this video's info yet — try again in a moment.");
                return;
            }

            // The DOM scrape sometimes loses the channel name (e.g. the
            // Polymer renderer hasn't filled in #channel-name yet). Fall
            // back to whatever the cache last saw so the modal title
            // doesn't say "Unknown" when we already know the answer.
            if (!pageInfo.channelName) {
                const cached = cacheGet(pageInfo.channelId);
                if (cached?.channelName) pageInfo.channelName = cached.channelName;
            }

            showModal(pageInfo);

            // Loading happens once per page: if a background task is
            // already running or done for this exact channel+video, just
            // re-attach the modal to it. The task survives modal closes
            // by design, so reopening on the same page never re-fetches.
            if (bgTask && bgTask.channelId === pageInfo.channelId && bgTask.videoId === pageInfo.videoId) {
                refreshUI();
                rebuildLogPanel();
                return;
            }

            startBackgroundLoad(pageInfo);
        }

        // ===== SPA Navigation =====

        function onNavigate() {
            closeModal();

            // Save any in-progress work before cancelling.
            if (bgTask && bgTask.playlists.length > 0) {
                saveBgTaskToCache();
            }

            bgGeneration++;
            bgTask = null;
            logEntries = [];

            ensureButton();
        }

        function init() {
            injectStyles();
            document.addEventListener("yt-navigate-finish", onNavigate);
            document.addEventListener("yt-page-data-updated", scheduleEnsureButton);
            document.addEventListener("yt-page-data-fetched", scheduleEnsureButton);
            window.addEventListener("popstate", scheduleEnsureButton);

            // The menu command is the official fallback if the in-page button
            // ever fails to appear (e.g. YouTube ships a layout change we don't
            // recognize yet).
            GM_registerMenuCommand("Find Playlists", onButtonClick);

            // Always run the watcher — ensureButton() is a no-op off /watch.
            // This guarantees recovery even if a navigation event is missed or
            // YouTube re-renders the actions row at any later time.
            startButtonWatch();

            console.info(LOG_PREFIX, "loaded");
        }

        // Userscripts usually run at document-end, but on some managers / corner
        // cases they fire earlier. Wait for document.body so MutationObserver
        // can attach.
        if (document.body) {
            init();
        } else {
            document.addEventListener("DOMContentLoaded", init, { once: true });
        }
    })();

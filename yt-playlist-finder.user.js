// ==UserScript==
// @name         YT Playlist Finder
// @namespace    https://github.com/Brandon123b/YT-Playlist-Finder
// @version      0.3.1
// @description  Find a YouTube playlist containing the current video from the same artist
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
// @supportURL   https://github.com/Brandon123b/YT-Playlist-Finder/issues
// @downloadURL  https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/yt-playlist-finder.user.js
// @updateURL    https://raw.githubusercontent.com/Brandon123b/YT-Playlist-Finder/main/yt-playlist-finder.meta.js
// ==/UserScript==

(function () {
    "use strict";

    // ===== Configuration =====

    const CONFIG = {
        CACHE_TTL_MS: 24 * 60 * 60 * 1000,
        CACHE_PREFIX: "cache_",
        FETCH_DELAY_MS: 300,
        PARALLEL_FETCHES: 5,
    };

    const LOG_PREFIX = "[YT Playlist Finder]";

    // ===== Utilities =====

    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(el);
                }
            });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`waitForElement("${selector}") timed out after ${timeout}ms`));
            }, timeout);

            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

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

    function cacheIsFresh(data) {
        if (!data || !data.lastChecked) return false;
        return (Date.now() - data.lastChecked) < CONFIG.CACHE_TTL_MS;
    }

    // ===== Page Data Extraction =====

    function getPageInfo() {
        const info = { videoId: null, channelId: null, channelName: null };

        info.videoId = new URLSearchParams(location.search).get("v");
        if (!info.videoId) {
            info.videoId = document.querySelector('meta[itemprop="videoId"]')?.content || null;
        }

        try {
            const pr = unsafeWindow?.ytInitialPlayerResponse;
            if (pr?.videoDetails?.channelId) {
                info.channelId = pr.videoDetails.channelId;
            }
        } catch (_) {}

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

        if (!info.channelId) {
            const links = document.querySelectorAll('a[href*="/channel/UC"]');
            for (const link of links) {
                const m = link.href.match(/\/channel\/(UC[\w-]+)/);
                if (m) { info.channelId = m[1]; break; }
            }
        }

        const nameEl = document.querySelector(
            "ytd-watch-metadata #channel-name a, ytd-video-owner-renderer #channel-name a"
        );
        if (nameEl) {
            info.channelName = nameEl.textContent.trim();
        }
        if (!info.channelName) {
            try {
                info.channelName = unsafeWindow?.ytInitialPlayerResponse?.videoDetails?.author || null;
            } catch (_) {}
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

    function parsePlaylistRenderer(renderer) {
        if (renderer._lockup) {
            const lk = renderer._lockup;
            const id = lk.contentId;
            const title = lk.metadata?.lockupMetadataViewModel?.title?.content;
            const thumb = lk.contentImage?.collectionThumbnailViewModel
                ?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url;

            let videoCount = 0;
            const metaRows = lk.metadata?.lockupMetadataViewModel?.metadata
                ?.contentMetadataViewModel?.metadataRows;
            if (metaRows) {
                for (const row of metaRows) {
                    for (const part of (row.metadataParts || [])) {
                        const txt = part?.text?.content;
                        if (txt) {
                            const n = parseInt(String(txt).replace(/[^0-9]/g, ""));
                            if (n > 0 && /video/i.test(txt)) { videoCount = n; break; }
                            if (n > 0 && !videoCount) videoCount = n;
                        }
                    }
                    if (videoCount) break;
                }
            }
            if (!videoCount) videoCount = extractVideoCountFromObj(lk.contentImage);
            if (!videoCount) videoCount = extractVideoCountFromObj(lk);

            if (id && title) return { id, title, thumbnailUrl: thumb || "", videoCount, videoIds: null, lastChecked: null };
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

        if (id && title) return { id, title, thumbnailUrl, videoCount, videoIds: null, lastChecked: null };
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

    async function fetchChannelPlaylists(channelId, onBatch) {
        const res = await fetch(`/channel/${channelId}/playlists`);
        if (!res.ok) throw new Error(`Failed to fetch channel page: ${res.status}`);

        const ytData = extractYtInitialData(await res.text());
        if (!ytData) throw new Error("Could not parse ytInitialData from channel page");

        const renderers = findPlaylistRenderers(ytData);
        const playlists = renderers.map(parsePlaylistRenderer).filter(Boolean);
        if (onBatch && playlists.length > 0) onBatch([...playlists]);

        let token = findContinuationToken(ytData);
        let page = 1;
        while (token) {
            page++;
            await sleep(CONFIG.FETCH_DELAY_MS);
            try {
                const data = await innerTubeBrowse(token);
                const newRenderers = [];
                for (const action of (data.onResponseReceivedActions || [])) {
                    findPlaylistRenderers(action.appendContinuationItemsAction?.continuationItems || [], newRenderers);
                }
                const batch = newRenderers.map(parsePlaylistRenderer).filter(Boolean);
                if (batch.length > 0) {
                    playlists.push(...batch);
                    if (onBatch) onBatch(batch);
                }
                token = findContinuationToken(data);
            } catch (e) {
                break;
            }
        }

        return playlists;
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

        if (targetVideoId && videoIds.includes(targetVideoId)) {
            return { videoIds, containsTarget: true };
        }

        let token = findContinuationToken(ytData);
        while (token) {
            await sleep(CONFIG.FETCH_DELAY_MS);
            try {
                const data = await innerTubeBrowse(token);
                for (const action of (data.onResponseReceivedActions || [])) {
                    for (const item of (action.appendContinuationItemsAction?.continuationItems || [])) {
                        if (item.playlistVideoRenderer?.videoId) {
                            videoIds.push(item.playlistVideoRenderer.videoId);
                        }
                    }
                }
                if (targetVideoId && videoIds.includes(targetVideoId)) {
                    return { videoIds, containsTarget: true };
                }
                token = findContinuationToken(data);
            } catch (e) {
                break;
            }
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
                margin-left: 8px;
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
    let activeTab = "matched";
    let searchQuery = "";
    let allSortMode = "az"; // "az", "za", "count-desc", "count-asc"

    function isBackgroundLoading() {
        return bgTask !== null && !bgTask.done && bgGeneration === bgTask.generation;
    }

    // ===== Activity Log =====

    function modalLog(msg) {
        const entry = { time: new Date(), msg };
        logEntries.push(entry);

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

    // ===== UI: Button =====

    const BUTTON_ID = "ytpf-button";

    function removeButton() {
        document.getElementById(BUTTON_ID)?.remove();
    }

    let buttonInjecting = false;

    async function injectButton() {
        if (buttonInjecting) return;
        buttonInjecting = true;
        removeButton();
        await sleep(800);
        removeButton();
        try {
            const container = await waitForElement(
                "#flexible-item-buttons, #top-level-buttons-computed, ytd-watch-metadata #actions"
            );
            if (document.getElementById(BUTTON_ID)) return;

            const btn = document.createElement("button");
            btn.id = BUTTON_ID;
            btn.className = "ytpf-btn";
            btn.title = "Find Playlists";
            btn.appendChild(createPlaylistIcon());
            btn.addEventListener("click", onButtonClick);
            container.appendChild(btn);
        } catch (e) {
            console.warn(LOG_PREFIX, "Button injection failed:", e.message);
        } finally {
            buttonInjecting = false;
        }
    }

    let buttonObserver = null;

    function startButtonWatch() {
        stopButtonWatch();
        buttonObserver = new MutationObserver(() => {
            if (location.pathname === "/watch" && !document.getElementById(BUTTON_ID)) {
                injectButton();
            }
        });
        buttonObserver.observe(document.body, { childList: true, subtree: true });
    }

    function stopButtonWatch() {
        if (buttonObserver) {
            buttonObserver.disconnect();
            buttonObserver = null;
        }
    }

    // ===== UI: Modal =====

    function closeModal() {
        if (currentModal) {
            currentModal.remove();
            currentModal = null;
            document.body.style.overflow = "";
        }
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
        const btnRefresh = createToolbarBtn("\u27f3 Refresh", "Refresh playlist data");
        const btnClearCh = createToolbarBtn("Clear Channel", "Remove cached data for this channel");
        const btnClearAll = createToolbarBtn("Clear All", "Remove all cached data");
        btnRefresh.addEventListener("click", () => startBackgroundLoad(pageInfo, true));
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

        const onKey = (e) => {
            if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", onKey); }
        };
        document.addEventListener("keydown", onKey);
    }

    function createToolbarBtn(text, title) {
        const btn = document.createElement("button");
        btn.className = "ytpf-toolbar-btn";
        btn.textContent = text;
        btn.title = title;
        return btn;
    }

    // ===== UI: Playlist Items =====

    function renderPlaylistItem(playlist, videoId, loading) {
        const containsVideo = playlist.videoIds ? playlist.videoIds.includes(videoId) : false;
        const notChecked = playlist.videoIds === null;

        const item = document.createElement("div");
        item.className = "ytpf-playlist-item" + (containsVideo ? " ytpf-contains-video" : "");
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
        if (containsVideo) {
            indicator.textContent = "\u2713";
        } else if (notChecked && loading) {
            indicator.appendChild(createSpinner());
        } else if (!notChecked) {
            indicator.textContent = "\u25cb";
            indicator.style.color = "#555";
        }

        item.append(thumb, info, indicator);

        item.addEventListener("click", () => {
            if (containsVideo) {
                window.location.href = `/watch?v=${videoId}&list=${playlist.id}`;
            } else {
                window.location.href = `/playlist?list=${playlist.id}`;
            }
        });

        return item;
    }

    // ===== Tab Rendering =====

    function updateTabCounts() {
        if (!bgTask) return;
        const matched = bgTask.playlists.filter(
            pl => pl.videoIds && pl.videoIds.includes(bgTask.videoId)
        ).length;
        const all = bgTask.playlists.length;

        const tabM = document.getElementById("ytpf-tab-matched");
        const tabA = document.getElementById("ytpf-tab-all");
        if (tabM) tabM.textContent = `Matched (${matched})`;
        if (tabA) tabA.textContent = `All (${all})`;
    }

    const SORT_LABELS = { "az": "A\u2192Z", "za": "Z\u2192A", "count-desc": "Most videos", "count-asc": "Fewest videos" };
    const SORT_CYCLE = ["az", "za", "count-desc", "count-asc"];

    function renderActiveTab() {
        const content = document.getElementById("ytpf-content");
        if (!content || !bgTask) return;
        clearChildren(content);

        const loading = isBackgroundLoading();
        let playlists;

        if (activeTab === "matched") {
            playlists = bgTask.playlists
                .filter(pl => pl.videoIds && pl.videoIds.includes(bgTask.videoId))
                .sort((a, b) => a.videoCount - b.videoCount);

            if (playlists.length === 0) {
                const allChecked = bgTask.playlists.length > 0
                    && bgTask.playlists.every(pl => pl.videoIds !== null);
                const msgDiv = document.createElement("div");
                msgDiv.className = "ytpf-empty";
                if (allChecked) {
                    msgDiv.textContent = "No playlists contain this video.";
                } else if (bgTask.playlists.length > 0) {
                    msgDiv.appendChild(createSpinner());
                    msgDiv.append(" Checking playlists\u2026");
                } else {
                    msgDiv.appendChild(createSpinner());
                    msgDiv.append(" Loading\u2026");
                }
                content.appendChild(msgDiv);
                return;
            }
        } else {
            // Filter bar for All tab
            const filterBar = document.createElement("div");
            filterBar.className = "ytpf-filter-bar";

            const searchInput = document.createElement("input");
            searchInput.className = "ytpf-search";
            searchInput.type = "text";
            searchInput.placeholder = "Search playlists\u2026";
            searchInput.value = searchQuery;
            searchInput.addEventListener("input", (e) => {
                searchQuery = e.target.value;
                renderActiveTab();
                // Re-focus and restore cursor position after re-render
                const input = document.querySelector(".ytpf-search");
                if (input) { input.focus(); input.selectionStart = input.selectionEnd = searchQuery.length; }
            });

            const sortBtn = document.createElement("button");
            sortBtn.className = "ytpf-sort-btn";
            sortBtn.textContent = SORT_LABELS[allSortMode];
            sortBtn.title = "Change sort order";
            sortBtn.addEventListener("click", () => {
                const idx = SORT_CYCLE.indexOf(allSortMode);
                allSortMode = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
                renderActiveTab();
            });

            filterBar.append(searchInput, sortBtn);
            content.appendChild(filterBar);

            playlists = [...bgTask.playlists];

            // Apply search filter
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                playlists = playlists.filter(pl => pl.title.toLowerCase().includes(q));
            }

            // Apply sort
            if (allSortMode === "az") {
                playlists.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
            } else if (allSortMode === "za") {
                playlists.sort((a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" }));
            } else if (allSortMode === "count-desc") {
                playlists.sort((a, b) => b.videoCount - a.videoCount);
            } else {
                playlists.sort((a, b) => a.videoCount - b.videoCount);
            }

            if (playlists.length === 0) {
                const msgDiv = document.createElement("div");
                msgDiv.className = "ytpf-empty";
                if (loading && bgTask.playlists.length === 0) {
                    msgDiv.appendChild(createSpinner());
                    msgDiv.append(" Loading playlists\u2026");
                } else if (searchQuery) {
                    msgDiv.textContent = "No playlists match your search.";
                } else {
                    msgDiv.textContent = "This channel has no playlists.";
                }
                content.appendChild(msgDiv);
                return;
            }
        }

        for (const pl of playlists) {
            content.appendChild(renderPlaylistItem(pl, bgTask.videoId, loading));
        }

        updateTabCounts();
    }

    function updateFooter() {
        const footer = document.getElementById("ytpf-footer");
        if (!footer || !bgTask) return;

        const total = bgTask.playlists.length;
        const checked = bgTask.playlists.filter(pl => pl.videoIds !== null).length;

        if (bgTask.done || (total > 0 && checked >= total)) {
            const when = new Date().toLocaleString();
            footer.textContent = `${total} playlist${total !== 1 ? "s" : ""} \u00b7 Last checked: ${when}`;
        } else if (total > 0) {
            footer.textContent = `Checking playlists\u2026 ${checked} / ${total}`;
        } else {
            footer.textContent = "Loading\u2026";
        }
    }

    function refreshUI() {
        if (!currentModal) return;
        updateTabCounts();
        renderActiveTab();
        updateFooter();
    }

    // ===== Background Loading =====

    function saveBgTaskToCache() {
        if (!bgTask) return;
        cacheSet(bgTask.channelId, {
            channelId: bgTask.channelId,
            channelName: bgTask.pageInfo.channelName,
            playlists: bgTask.playlists,
        });
    }

    async function fetchVideoIdsParallel(playlists, pageInfo, gen, forceRefresh) {
        let index = 0;
        let checked = 0;
        const total = playlists.length;

        async function worker() {
            while (bgGeneration === gen) {
                const i = index++;
                if (i >= playlists.length) break;
                const pl = playlists[i];

                if (!forceRefresh && pl.videoIds && pl.lastChecked && (Date.now() - pl.lastChecked) < CONFIG.CACHE_TTL_MS) {
                    checked++;
                    modalLog(`[${checked}/${total}] "${pl.title}" \u2014 cached (${pl.videoIds.length} videos)`);
                    refreshUI();
                    continue;
                }

                try {
                    await sleep(CONFIG.FETCH_DELAY_MS);
                    if (bgGeneration !== gen) break;
                    const result = await fetchPlaylistVideoIds(pl.id, pageInfo.videoId);
                    pl.videoIds = result.videoIds;
                    pl.lastChecked = Date.now();
                    checked++;
                    const match = result.containsTarget ? " \u2605 MATCH" : "";
                    modalLog(`[${checked}/${total}] "${pl.title}" \u2014 ${result.videoIds.length} videos${match}`);
                } catch (e) {
                    pl.videoIds = [];
                    pl.lastChecked = Date.now();
                    checked++;
                    modalLog(`[${checked}/${total}] "${pl.title}" \u2014 error: ${e.message}`);
                }

                refreshUI();

                if (checked % 10 === 0) saveBgTaskToCache();
            }
        }

        const workers = [];
        for (let w = 0; w < CONFIG.PARALLEL_FETCHES; w++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }

    async function startBackgroundLoad(pageInfo, forceRefresh) {
        const gen = ++bgGeneration;
        logEntries = [];

        bgTask = {
            channelId: pageInfo.channelId,
            videoId: pageInfo.videoId,
            generation: gen,
            playlists: [],
            pageInfo,
            done: false,
        };

        activeTab = "matched";
        const tabM = document.getElementById("ytpf-tab-matched");
        const tabA = document.getElementById("ytpf-tab-all");
        if (tabM) tabM.classList.add("ytpf-tab-active");
        if (tabA) tabA.classList.remove("ytpf-tab-active");

        refreshUI();
        rebuildLogPanel();

        modalLog(`Fetching playlists for ${pageInfo.channelName || pageInfo.channelId}\u2026`);

        const cached = forceRefresh ? null : cacheGet(pageInfo.channelId);

        if (cached?.playlists) {
            bgTask.playlists = cached.playlists;
            modalLog(`Loaded ${cached.playlists.length} playlists from cache`);
            refreshUI();

            if (cacheIsFresh(cached)) {
                // Check if all video IDs are already fetched
                const allChecked = cached.playlists.every(pl => pl.videoIds !== null);
                if (allChecked) {
                    bgTask.done = true;
                    const matched = bgTask.playlists.filter(pl => pl.videoIds?.includes(pageInfo.videoId)).length;
                    modalLog(`All ${cached.playlists.length} playlists already checked. ${matched} matched.`);
                    refreshUI();
                    return;
                }
                // Cache is fresh but some playlists haven't been checked — continue checking
                modalLog(`Cache fresh but ${cached.playlists.filter(pl => pl.videoIds === null).length} playlists unchecked. Resuming\u2026`);
                await fetchVideoIdsParallel(bgTask.playlists, pageInfo, gen, false);
                if (bgGeneration !== gen) return;
                bgTask.done = true;
                saveBgTaskToCache();
                const matched = bgTask.playlists.filter(pl => pl.videoIds?.includes(pageInfo.videoId)).length;
                modalLog(`Done. ${matched} playlist${matched !== 1 ? "s" : ""} contain this video.`);
                refreshUI();
                return;
            }
        }

        try {
            const allPlaylists = await fetchChannelPlaylists(pageInfo.channelId, (batch) => {
                if (bgGeneration !== gen) return;
                for (const pl of batch) {
                    if (!bgTask.playlists.find(p => p.id === pl.id)) {
                        bgTask.playlists.push(pl);
                    }
                }
                modalLog(`Found ${bgTask.playlists.length} playlists so far\u2026`);
                refreshUI();
            });

            if (bgGeneration !== gen) return;

            if (allPlaylists.length === 0) {
                bgTask.playlists = [];
                bgTask.done = true;
                modalLog("This channel has no playlists.");
                refreshUI();
                return;
            }

            bgTask.playlists = allPlaylists.map(pl => {
                const prev = cached?.playlists?.find(c => c.id === pl.id);
                return { ...pl, videoIds: prev?.videoIds || null, lastChecked: prev?.lastChecked || null };
            });
            refreshUI();

            modalLog(`Checking ${bgTask.playlists.length} playlists for current video\u2026`);

            await fetchVideoIdsParallel(bgTask.playlists, pageInfo, gen, forceRefresh);

            if (bgGeneration !== gen) return;

            bgTask.done = true;
            saveBgTaskToCache();
            const matched = bgTask.playlists.filter(pl => pl.videoIds?.includes(pageInfo.videoId)).length;
            modalLog(`Done. ${matched} playlist${matched !== 1 ? "s" : ""} contain this video.`);
            refreshUI();
        } catch (e) {
            modalLog(`Error: ${e.message}`);
            if (bgTask && bgGeneration === gen) {
                bgTask.done = true;
                if (bgTask.playlists.length > 0) saveBgTaskToCache();
            }
            if (currentModal) {
                const content = document.getElementById("ytpf-content");
                if (content) {
                    clearChildren(content);
                    const errorDiv = document.createElement("div");
                    errorDiv.className = "ytpf-error";
                    errorDiv.append("Failed to load playlists. ");
                    const retryBtn = document.createElement("button");
                    retryBtn.className = "ytpf-retry";
                    retryBtn.textContent = "Retry";
                    retryBtn.addEventListener("click", () => startBackgroundLoad(pageInfo, true));
                    errorDiv.appendChild(retryBtn);
                    content.appendChild(errorDiv);
                }
            }
        }
    }

    // ===== Main Entry Point =====

    async function onButtonClick() {
        if (currentModal) { closeModal(); return; }

        const pageInfo = getPageInfo();

        if (!pageInfo.videoId || !pageInfo.channelId) {
            return;
        }

        showModal(pageInfo);

        // If a background task is already running or done for this channel+video, just show it
        if (bgTask && bgTask.channelId === pageInfo.channelId && bgTask.videoId === pageInfo.videoId) {
            refreshUI();
            rebuildLogPanel();
            return;
        }

        startBackgroundLoad(pageInfo, false);
    }

    // ===== SPA Navigation =====

    function onNavigate() {
        closeModal();

        // Save any in-progress work before cancelling
        if (bgTask && bgTask.playlists.length > 0) {
            saveBgTaskToCache();
        }

        bgGeneration++;
        bgTask = null;
        logEntries = [];

        if (location.pathname === "/watch") {
            injectButton();
            startButtonWatch();
        } else {
            removeButton();
            stopButtonWatch();
        }
    }

    function init() {
        console.log(LOG_PREFIX, "Initialized");
        injectStyles();
        document.addEventListener("yt-navigate-finish", onNavigate);

        GM_registerMenuCommand("Find Playlists", onButtonClick);

        if (location.pathname === "/watch") {
            injectButton();
            startButtonWatch();
        }
    }

    init();
})();

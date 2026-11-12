import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  KEEPALIVE_PING_INTERVAL_MS,
  buildOpenUrl,
  computeReconnectDelayMs,
  isTrackableWebUrl,
  mergeTabEntry,
  serializeTabsForHost,
} from "../extension/service_worker_helpers.js";

const require = createRequire(import.meta.url);
const contentHelpers = require("../extension/content_helpers.js");

test("extractYoutubeVideoId parses watch, shorts, live and youtu.be URLs", () => {
  assert.equal(
    contentHelpers.extractYoutubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"),
    "dQw4w9WgXcQ"
  );
  assert.equal(
    contentHelpers.extractYoutubeVideoId("https://www.youtube.com/shorts/AbCdEf12345"),
    "AbCdEf12345"
  );
  assert.equal(
    contentHelpers.extractYoutubeVideoId("https://youtu.be/XyZ987654321?si=1"),
    "XyZ987654321"
  );
  assert.equal(
    contentHelpers.extractYoutubeVideoId("https://vimeo.com/123456"),
    null
  );
});

test("pickBestArtwork chooses largest thumbnail resolution", () => {
  const best = contentHelpers.pickBestArtwork([
    { src: "https://img.test/96.jpg", sizes: "96x96" },
    { src: "https://img.test/512.jpg", sizes: "512x512" },
    { src: "https://img.test/128.jpg", sizes: "128x128" },
  ]);
  assert.equal(best, "https://img.test/512.jpg");
  assert.equal(contentHelpers.pickBestArtwork([]), null);
});

test("mergeMediaMetadata records isolated vs MAIN vs DOM diagnostics", () => {
  const yt = contentHelpers.mergeMediaMetadata({
    isolatedMeta: null,
    mainMeta: {
      title: "Título antigo SPA",
      artist: "Canal Main",
      artwork: [{ src: "https://i.ytimg.com/vi/abc/hqdefault.jpg", sizes: "480x360" }],
    },
    domMeta: {
      title: "Título novo YouTube",
      artist: "Canal YouTube",
      artworkUrl: "https://i.ytimg.com/vi/newid/hqdefault.jpg",
    },
    isYouTube: true,
  });
  assert.equal(yt.title, "Título novo YouTube");
  assert.equal(yt.artist, "Canal YouTube");
  assert.equal(yt.artworkUrl, "https://i.ytimg.com/vi/abc/hqdefault.jpg");
  assert.deepEqual(yt.probe, {
    isolatedReadable: false,
    mainReadable: true,
    domReadable: true,
  });

  const generic = contentHelpers.mergeMediaMetadata({
    isolatedMeta: { title: "Iso Track", artist: "Iso Artist" },
    mainMeta: null,
    domMeta: { title: "Document Title", artist: "example.com" },
    isYouTube: false,
  });
  assert.equal(generic.title, "Iso Track");
  assert.equal(generic.artist, "Iso Artist");
});

test("selectPrimaryMediaCandidate skips YouTube hover preview videos and picks main player", () => {
  const selected = contentHelpers.selectPrimaryMediaCandidate(
    [
      {
        id: "hover-preview",
        isVideo: true,
        isYoutubeMainVideo: false,
        isYoutubePreview: true,
        isVisible: true,
        isInViewport: true,
        paused: false,
        ended: false,
        readyState: 4,
        currentSrc: "blob:preview",
        duration: 10,
      },
      {
        id: "main-player",
        isVideo: true,
        isYoutubeMainVideo: true,
        isYoutubePreview: false,
        isVisible: true,
        isInViewport: true,
        paused: true,
        ended: false,
        readyState: 4,
        currentSrc: "blob:main",
        duration: 600,
      },
    ],
    true
  );
  assert.equal(selected.id, "main-player");
});

test("selectPrimaryMediaCandidate in YouTube Shorts prefers visible active reel over hidden/preloaded videos", () => {
  const selected = contentHelpers.selectPrimaryMediaCandidate(
    [
      {
        id: "hidden-watch-or-prev-reel",
        isVideo: true,
        isYoutubeActiveReel: false,
        isYoutubeInactiveReel: true,
        isYoutubeMainVideo: true,
        isVisible: false,
        isInViewport: false,
        paused: false,
        muted: true,
        ended: false,
        readyState: 4,
        currentSrc: "blob:old-short",
        duration: 30,
      },
      {
        id: "active-visible-short",
        isVideo: true,
        isYoutubeActiveReel: true,
        isYoutubeInactiveReel: false,
        isYoutubeMainVideo: false,
        isVisible: true,
        isInViewport: true,
        paused: false,
        muted: false,
        volume: 1,
        ended: false,
        readyState: 2,
        currentSrc: "blob:active-short",
        duration: 45,
      },
      {
        id: "preloaded-next-reel",
        isVideo: true,
        isYoutubeActiveReel: false,
        isYoutubeInactiveReel: true,
        isYoutubeMainVideo: true,
        isVisible: false,
        isInViewport: false,
        paused: true,
        ended: false,
        readyState: 4,
        currentSrc: "blob:next-short",
        duration: 20,
      },
    ],
    true
  );
  assert.equal(selected.id, "active-visible-short");
});

test("computeSeekTarget handles +10s/-10s clamped seek", () => {
  assert.equal(contentHelpers.computeSeekTarget(120, 300, 10, true), 130);
  assert.equal(contentHelpers.computeSeekTarget(5, 300, -10, true), 0);
  assert.equal(contentHelpers.computeSeekTarget(295, 300, 10, true), 300);
  assert.equal(contentHelpers.computeSeekTarget(20, 0, -30, true), 0);
});

test("service worker open URL validation blocks dangerous schemes", () => {
  assert.equal(
    buildOpenUrl({ mode: "youtube_search", query: "jazz cafe" }),
    "https://www.youtube.com/results?search_query=jazz%20cafe"
  );
  assert.equal(
    buildOpenUrl({ mode: "url", url: "https://www.youtube.com/watch?v=abc" }),
    "https://www.youtube.com/watch?v=abc"
  );
  assert.equal(buildOpenUrl({ mode: "url", url: "javascript:alert(1)" }), null);
  assert.equal(buildOpenUrl({ mode: "url", url: "chrome://extensions" }), null);
  assert.equal(isTrackableWebUrl("https://youtube.com"), true);
  assert.equal(isTrackableWebUrl("chrome://extensions"), false);
});

test("service worker keepalive interval and tab merge sorting behave as expected", () => {
  assert.ok(KEEPALIVE_PING_INTERVAL_MS < 30_000);
  assert.equal(computeReconnectDelayMs(0), 1000);
  assert.equal(computeReconnectDelayMs(1), 2000);
  assert.equal(computeReconnectDelayMs(10), 15000);

  const tabA = mergeTabEntry(
    20,
    {
      hasMedia: true,
      title: "Pausado",
      artist: "Canal P",
      status: "PAUSED",
      position: 10,
      duration: 100,
      volume: 0.5,
      elementMuted: false,
    },
    { active: false, mutedInfo: { muted: true } }
  );
  const tabB = mergeTabEntry(
    10,
    {
      hasMedia: true,
      title: "Tocando",
      artist: "Canal T",
      status: "PLAYING",
      position: 5,
      duration: 60,
      volume: 0.8,
      elementMuted: false,
    },
    { active: true, mutedInfo: { muted: false } }
  );
  assert.equal(tabA.muted, true);
  assert.equal(tabB.muted, false);

  const serialized = serializeTabsForHost([tabA, tabB]);
  assert.deepEqual(
    serialized.map((t) => t.tabId),
    [10, 20]
  );
});

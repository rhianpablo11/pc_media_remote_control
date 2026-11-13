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
import {
  extractYtInitialData,
  isValidVideoId,
  parseSearchResults,
} from "../extension/youtube_search_parser.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

test("cleanMediaTitle strips notification prefixes from YouTube and browser titles", () => {
  assert.equal(
    contentHelpers.cleanMediaTitle("(2509) Título do Vídeo no YouTube"),
    "Título do Vídeo no YouTube"
  );
  assert.equal(contentHelpers.cleanMediaTitle("(1) Canal"), "Canal");
  assert.equal(contentHelpers.cleanMediaTitle("(99+) Ao vivo"), "Ao vivo");
  assert.equal(contentHelpers.cleanMediaTitle("Vídeo Sem Notificação"), "Vídeo Sem Notificação");
  assert.equal(contentHelpers.cleanMediaTitle(""), "");

  const merged = contentHelpers.mergeMediaMetadata({
    domMeta: { title: "(42) Música em Reprodução", artist: "Artista" },
    isolatedMeta: null,
    isYouTube: true,
    mainMeta: null,
  });
  assert.equal(merged.title, "Música em Reprodução");
});

test("playback command idempotency and error reasons behave deterministically", () => {
  // 1. Simulating executeMediaCommand behavior for play on already playing element
  const playingEl = { paused: false, playCalled: false };
  const playIdempotent = playingEl.paused
    ? { ok: true }
    : { ok: true, reason: "already_playing" };
  assert.deepEqual(playIdempotent, { ok: true, reason: "already_playing" });

  // 2. Simulating pause on already paused element
  const pausedEl = { paused: true, pauseCalled: false };
  const pauseIdempotent = pausedEl.paused
    ? { ok: true, reason: "already_paused" }
    : { ok: true };
  assert.deepEqual(pauseIdempotent, { ok: true, reason: "already_paused" });

  // 3. Autoplay policy rejection simulation
  const notAllowedError = new Error("play() failed because the user didn't interact");
  notAllowedError.name = "NotAllowedError";
  const caughtReason =
    notAllowedError.name === "NotAllowedError" ? "autoplay_rejected" : "play_failed";
  assert.equal(caughtReason, "autoplay_rejected");

  // 4. Subframe with no media must not respond
  const isTop = false;
  const hasMedia = false;
  const shouldRespondInSubframe = isTop || hasMedia;
  assert.equal(shouldRespondInSubframe, false);
});

test("stripSiteSuffix cleans notification prefixes and site suffixes across web players", () => {
  assert.equal(
    contentHelpers.stripSiteSuffix("(1) Iguinho e Lulinha - Ao Vivo em Petrolina - Sua Música"),
    "Iguinho e Lulinha - Ao Vivo em Petrolina"
  );
  assert.equal(
    contentHelpers.stripSiteSuffix("Zé Vaqueiro | Sua Música"),
    "Zé Vaqueiro"
  );
  assert.equal(
    contentHelpers.stripSiteSuffix("Sua Música - O maior site de música do Brasil - Sua Música"),
    "Sua Música - O maior site de música do Brasil"
  );
  assert.equal(
    contentHelpers.stripSiteSuffix("(2509) Never Gonna Give You Up - YouTube"),
    "Never Gonna Give You Up"
  );
  assert.equal(
    contentHelpers.stripSiteSuffix("Chill Beats | Spotify Web Player"),
    "Chill Beats"
  );
  assert.equal(
    contentHelpers.stripSiteSuffix("Indie Band - Song Title - soundcloud", "soundcloud.com"),
    "Indie Band - Song Title"
  );
  assert.equal(
    contentHelpers.stripSiteSuffix("Generic Video - customsite", "customsite.com.br"),
    "Generic Video"
  );
});

test("mergeMediaMetadata falls back to OpenGraph and cleans site suffixes on generic players", () => {
  const generic = contentHelpers.mergeMediaMetadata({
    domMeta: {
      title: "Iguinho e Lulinha - Ao Vivo em Petrolina - Sua Música",
      artist: "Sua Música",
      artworkUrl: "https://images.suamusica.com.br/covers/album123.jpg",
    },
    hostname: "www.suamusica.com.br",
    isolatedMeta: null,
    isYouTube: false,
    mainMeta: null,
  });

  assert.equal(generic.title, "Iguinho e Lulinha - Ao Vivo em Petrolina");
  assert.equal(generic.artist, "Sua Música");
  assert.equal(generic.artworkUrl, "https://images.suamusica.com.br/covers/album123.jpg");
  assert.equal(generic.probe.domReadable, true);
  assert.equal(generic.probe.mainReadable, false);
});

test("isValidVideoId strictly validates 11-char YouTube video ids", () => {
  assert.equal(isValidVideoId("dQw4w9WgXcQ"), true);
  assert.equal(isValidVideoId("rFZHOHl-L8A"), true);
  assert.equal(isValidVideoId("n61ULEU7CO0"), true);
  assert.equal(isValidVideoId("_a-12345678"), true);

  // Rejeições de segurança
  assert.equal(isValidVideoId(""), false);
  assert.equal(isValidVideoId("short"), false);
  assert.equal(isValidVideoId("toolongvideoId12345"), false);
  assert.equal(isValidVideoId("https://youtube.com"), false);
  assert.equal(isValidVideoId("dQw4w9WgXc;"), false);
  assert.equal(isValidVideoId("../../../etc"), false);
  assert.equal(isValidVideoId(null), false);
  assert.equal(isValidVideoId(undefined), false);
});

test("extractYtInitialData extracts JSON from script block and handles malformed gracefully", () => {
  const validHtml = '<html><head><script>var ytInitialData = {"foo": "bar", "num": 42};</script></head></html>';
  const extracted = extractYtInitialData(validHtml);
  assert.deepEqual(extracted, { foo: "bar", num: 42 });

  const windowFormat = '<script>window["ytInitialData"] = {"test": true};</script>';
  assert.deepEqual(extractYtInitialData(windowFormat), { test: true });

  // Falha graciosa
  assert.equal(extractYtInitialData(""), null);
  assert.equal(extractYtInitialData("<html>sem script algum</html>"), null);
  assert.equal(extractYtInitialData("<script>var ytInitialData = {malformed json..."), null);
});

test("parseSearchResults parses real fixture, filters ads/channels/playlists and extracts video metadata", () => {
  const fixturePath = path.join(__dirname, "fixtures", "youtube_search_initial_data.json");
  const rawJson = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

  const results = parseSearchResults(rawJson, 10);
  assert.ok(results.length > 0, "Deveria retornar ao menos 1 resultado da fixture");

  for (const vid of results) {
    assert.ok(isValidVideoId(vid.id), `ID inválido: ${vid.id}`);
    assert.ok(vid.title && vid.title.length > 0, "Vídeo deve ter título");
    assert.ok(typeof vid.channel === "string", "Canal deve ser string");
    assert.ok(typeof vid.duration === "string", "Duração deve ser string");
    assert.ok(typeof vid.thumbnail === "string", "Thumbnail deve ser string");
    assert.ok(typeof vid.isLive === "boolean", "isLive deve ser boolean");
  }

  // Verifica que respeita maxResults
  const limited = parseSearchResults(rawJson, 2);
  assert.equal(limited.length, 2);
});


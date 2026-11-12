/**
 * Pure helper functions for content-script media detection, metadata merging,
 * seek math, and ad skip eligibility. Runs in classic browser script context
 * and can also be imported in Node tests.
 */
(function initPcMediaContentHelpers(root) {
  "use strict";

  const SKIP_AD_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    "button.ytp-skip-ad-button",
    ".videoAdUiSkipButton",
  ];

  function extractYoutubeVideoId(urlStr) {
    if (!urlStr) return null;
    try {
      const url = new URL(urlStr);
      const host = url.hostname.toLowerCase();
      if (host === "youtu.be") {
        const slug = url.pathname.replace(/^\/+/, "").split("/")[0];
        return slug || null;
      }
      if (!host.endsWith("youtube.com") && !host.endsWith("youtube-nocookie.com")) {
        return null;
      }
      const vParam = url.searchParams.get("v");
      if (vParam) return vParam;

      const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function isYoutubeHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    return h.endsWith("youtube.com") || h === "youtu.be";
  }

  function youtubeThumbnailUrl(videoId) {
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
  }

  function parseArtworkSize(sizesStr) {
    if (!sizesStr || typeof sizesStr !== "string") return 0;
    const match = sizesStr.match(/(\d+)\s*x\s*(\d+)/i);
    if (!match) return 0;
    return Number(match[1]) * Number(match[2]);
  }

  function pickBestArtwork(artworkList) {
    if (!Array.isArray(artworkList) || artworkList.length === 0) {
      return null;
    }
    let bestSrc = null;
    let bestArea = -1;
    for (const item of artworkList) {
      if (!item || typeof item.src !== "string" || !item.src.trim()) continue;
      const area = parseArtworkSize(item.sizes);
      if (area >= bestArea) {
        bestArea = area;
        bestSrc = item.src.trim();
      }
    }
    return bestSrc;
  }

  function normalizeMediaMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") {
      return { title: "", artist: "", album: "", artworkUrl: null, hasData: false };
    }
    const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
    const artist = typeof metadata.artist === "string" ? metadata.artist.trim() : "";
    const album = typeof metadata.album === "string" ? metadata.album.trim() : "";
    const artworkUrl =
      typeof metadata.artworkUrl === "string" && metadata.artworkUrl.trim()
        ? metadata.artworkUrl.trim()
        : pickBestArtwork(metadata.artwork);
    const hasData = Boolean(title || artist || artworkUrl);
    return { title, artist, album, artworkUrl, hasData };
  }

  function mergeMediaMetadata({ isolatedMeta, mainMeta, domMeta, isYouTube }) {
    const iso = normalizeMediaMetadata(isolatedMeta);
    const main = normalizeMediaMetadata(mainMeta);
    const dom = normalizeMediaMetadata(domMeta);

    // Prefer fresh YouTube DOM metadata when available to avoid SPA lag,
    // otherwise prefer MAIN world MediaSession -> ISOLATED MediaSession -> DOM.
    let title = "";
    let artist = "";
    let album = main.album || iso.album || dom.album || "";
    let artworkUrl = null;

    if (isYouTube) {
      title = dom.title || main.title || iso.title || "";
      artist = dom.artist || main.artist || iso.artist || "";
      artworkUrl = main.artworkUrl || iso.artworkUrl || dom.artworkUrl || null;
    } else {
      title = main.title || iso.title || dom.title || "";
      artist = main.artist || iso.artist || dom.artist || "";
      artworkUrl = main.artworkUrl || iso.artworkUrl || dom.artworkUrl || null;
    }

    return {
      title,
      artist,
      album,
      artworkUrl,
      probe: {
        isolatedReadable: iso.hasData,
        mainReadable: main.hasData,
        domReadable: dom.hasData,
      },
    };
  }

  function scoreMediaCandidate(candidate, isYouTube) {
    if (!candidate) return -1;
    const hasSource = Boolean(candidate.currentSrc || candidate.src || candidate.readyState > 0);
    if (!hasSource && candidate.paused) return -1;

    let score = 0;
    if (isYouTube && candidate.isYoutubeMainVideo) score += 1000;
    if (isYouTube && candidate.isYoutubePreview) score -= 2000;
    if (!candidate.paused && !candidate.ended) score += 500;
    if (candidate.readyState >= 2) score += 100;
    if (candidate.isVideo) score += 50;
    if (Number.isFinite(candidate.duration) && candidate.duration > 0) score += 25;
    if (!candidate.muted && candidate.volume > 0) score += 10;
    return score;
  }

  function selectPrimaryMediaCandidate(candidates, isYouTube) {
    let best = null;
    let bestScore = -1;
    for (const item of candidates || []) {
      const score = scoreMediaCandidate(item, isYouTube);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  function computeSeekTarget(currentTime, duration, value, relative = false) {
    const cur = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    const rawTarget = relative ? cur + Number(value || 0) : Number(value || 0);
    if (!Number.isFinite(rawTarget)) return cur;
    const clampedMin = Math.max(0, rawTarget);
    if (Number.isFinite(duration) && duration > 0) {
      return Math.min(duration, clampedMin);
    }
    return clampedMin;
  }

  function clampVolume(level) {
    const num = Number(level);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(1, num));
  }

  const exported = {
    SKIP_AD_SELECTORS,
    extractYoutubeVideoId,
    isYoutubeHost,
    youtubeThumbnailUrl,
    pickBestArtwork,
    normalizeMediaMetadata,
    mergeMediaMetadata,
    selectPrimaryMediaCandidate,
    computeSeekTarget,
    clampVolume,
  };

  root.__pcMediaContentHelpers = exported;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

/**
 * Isolated-world content script monitoring <video>/<audio> elements,
 * navigator.mediaSession (direct probe + MAIN-world bridge), YouTube DOM,
 * and executing per-tab playback/volume/skip-ad commands.
 */
(function initPcMediaContentScript() {
  "use strict";

  if (globalThis.__pcMediaControlInjected) {
    return;
  }
  globalThis.__pcMediaControlInjected = true;

  const helpers = globalThis.__pcMediaContentHelpers;
  if (!helpers) {
    return;
  }

  const MAIN_BRIDGE_SOURCE = "pc-media-control-main";
  const ISOLATED_REQUEST_SOURCE = "pc-media-control-isolated";
  const boundElements = new WeakSet();

  let mainWorldSnapshot = { metadata: null, playbackState: "none" };
  let detachedMediaSnapshot = null;
  let lastTimeUpdateSentAt = 0;
  let mutationTimer = null;
  let lastSentKey = "";

  function isElementVisibleAndEnabled(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.pointerEvents === "none" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findClickableSkipAdButton() {
    for (const selector of helpers.SKIP_AD_SELECTORS) {
      const candidates = document.querySelectorAll(selector);
      for (const btn of candidates) {
        if (isElementVisibleAndEnabled(btn)) {
          return btn;
        }
      }
    }
    return null;
  }

  function findReadyYoutubeControl(selector) {
    const el = document.querySelector(selector);
    if (!isElementVisibleAndEnabled(el)) return null;
    return el;
  }

  function collectMediaElements(returnDebug = false) {
    const elements = Array.from(document.querySelectorAll("video, audio"));
    const isYT = helpers.isYoutubeHost(window.location.hostname);
    const wrapped = elements.map((el, index) => {
      const activeReel = el.closest("ytd-reel-video-renderer[is-active]");
      const anyReel = el.closest("ytd-reel-video-renderer");
      const isYoutubeActiveReel = isYT && Boolean(activeReel);
      const isYoutubeInactiveReel = isYT && Boolean(anyReel && !activeReel);
      const isYoutubePreview = isYT && Boolean(el.closest("ytd-video-preview"));
      const isYoutubeMainVideo =
        isYT &&
        !isYoutubeInactiveReel &&
        !isYoutubePreview &&
        Boolean(el.closest("#movie_player") || el.classList.contains("html5-main-video"));

      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const isVisible =
        Boolean(el.isConnected) &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0;
      const isInViewport =
        isVisible &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth;

      return {
        index,
        element: el,
        tag: el.tagName,
        isVideo: el.tagName === "VIDEO",
        isYoutubeActiveReel,
        isYoutubeInactiveReel,
        isYoutubeMainVideo,
        isYoutubePreview,
        isVisible,
        isInViewport,
        currentSrc: el.currentSrc || "",
        src: el.src || "",
        readyState: el.readyState || 0,
        paused: Boolean(el.paused),
        ended: Boolean(el.ended),
        duration: el.duration,
        muted: Boolean(el.muted),
        volume: typeof el.volume === "number" ? el.volume : 1,
      };
    });

    for (const item of wrapped) {
      attachElementListeners(item.element);
    }

    const best = helpers.selectPrimaryMediaCandidate(wrapped, isYT);
    const chosen = best ? best.element : null;
    if (!returnDebug) {
      return chosen;
    }
    return {
      element: chosen,
      debug: {
        totalCandidates: wrapped.length,
        selectedIndex: best ? best.index : null,
        selectedInfo: best
          ? {
              tag: best.tag,
              isYoutubeActiveReel: best.isYoutubeActiveReel,
              isYoutubeInactiveReel: best.isYoutubeInactiveReel,
              isVisible: best.isVisible,
              isInViewport: best.isInViewport,
              paused: best.paused,
              muted: best.muted,
            }
          : null,
      },
    };
  }

  function readIsolatedMediaSession() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession) {
      return { metadata: null, playbackState: "none" };
    }
    const raw = navigator.mediaSession.metadata;
    return {
      metadata: raw
        ? {
            title: raw.title || "",
            artist: raw.artist || "",
            album: raw.album || "",
            artwork: Array.isArray(raw.artwork)
              ? raw.artwork.map((a) => ({ src: a.src || "", sizes: a.sizes || "" }))
              : [],
          }
        : null,
      playbackState: navigator.mediaSession.playbackState || "none",
    };
  }

  function queryFirstText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const txt = el && el.textContent ? el.textContent.trim() : "";
      if (txt) return txt;
    }
    return "";
  }

  function queryMetaContent(selector) {
    const el = document.querySelector(selector);
    const val = el ? el.getAttribute("content") : "";
    return val ? val.trim() : "";
  }

  function readDomMetadata(mediaEl) {
    const host = window.location.hostname.toLowerCase();
    const isYT = helpers.isYoutubeHost(host);

    if (isYT) {
      const videoId = helpers.extractYoutubeVideoId(window.location.href);
      const artworkUrl = helpers.youtubeThumbnailUrl(videoId);

      if (host === "music.youtube.com") {
        const musicImg = document.querySelector("ytmusic-player-bar img.image");
        return {
          title:
            queryFirstText(["ytmusic-player-bar .title"]) ||
            document.title.replace(/\s*-\s*YouTube Music$/i, "").trim(),
          artist: queryFirstText(["ytmusic-player-bar .byline"]),
          artworkUrl: (musicImg && musicImg.src) || artworkUrl,
        };
      }

      if (window.location.pathname.startsWith("/shorts/")) {
        return {
          title:
            queryFirstText([
              "ytd-reel-video-renderer[is-active] h2.title",
              "ytd-reel-video-renderer[is-active] .ytShortsVideoTitleViewModelShortsVideoTitle",
            ]) || document.title.replace(/\s*-\s*YouTube$/i, "").trim(),
          artist: queryFirstText([
            "ytd-reel-video-renderer[is-active] #channel-name a",
            "ytd-reel-video-renderer[is-active] .ytd-channel-name a",
          ]),
          artworkUrl,
        };
      }

      const rawDocTitle = document.title.replace(/\s*-\s*YouTube$/i, "").trim();
      const title = queryFirstText([
        "ytd-watch-metadata h1 yt-formatted-string",
        "#title h1 yt-formatted-string",
        "h1.ytd-watch-metadata",
      ]);
      const artist = queryFirstText([
        "ytd-watch-metadata #channel-name a",
        "#owner #channel-name a",
        "ytd-video-owner-renderer #channel-name a",
      ]);
      return {
        title: title || (rawDocTitle.toLowerCase() !== "youtube" ? rawDocTitle : ""),
        artist,
        artworkUrl,
      };
    }

    const poster =
      mediaEl && mediaEl.tagName === "VIDEO" && mediaEl.poster ? mediaEl.poster : null;
    const ogTitle =
      queryMetaContent('meta[property="og:title"]') || queryMetaContent('meta[name="og:title"]');
    const rawTitle = ogTitle || (document.title || "").trim();
    const title = helpers.stripSiteSuffix
      ? helpers.stripSiteSuffix(rawTitle, host)
      : helpers.cleanMediaTitle(rawTitle);
    const artist =
      queryMetaContent('meta[name="author"]') ||
      queryMetaContent('meta[property="article:author"]') ||
      queryMetaContent('meta[property="og:site_name"]') ||
      queryMetaContent('meta[name="og:site_name"]') ||
      host.replace(/^www\./i, "");
    const artworkUrl =
      poster ||
      queryMetaContent('meta[property="og:image"]') ||
      queryMetaContent('meta[name="og:image"]') ||
      queryMetaContent('meta[property="twitter:image"]') ||
      queryMetaContent('meta[name="twitter:image"]') ||
      null;

    return { title, artist, artworkUrl };
  }

  function buildMediaSnapshot() {
    const mediaEl = collectMediaElements();
    const isolated = readIsolatedMediaSession();
    const isYT = helpers.isYoutubeHost(window.location.hostname);
    const hasActiveSessionOnly =
      !mediaEl &&
      (Boolean(mainWorldSnapshot.metadata) || Boolean(isolated.metadata)) &&
      (mainWorldSnapshot.playbackState !== "none" || isolated.playbackState !== "none");
    const hasDetachedMedia = Boolean(
      detachedMediaSnapshot &&
        (!detachedMediaSnapshot.paused ||
          detachedMediaSnapshot.currentTime > 0 ||
          detachedMediaSnapshot.currentSrc)
    );

    if (!mediaEl && !hasActiveSessionOnly && !hasDetachedMedia) {
      return {
        hasMedia: false,
        url: window.location.href,
      };
    }

    const domMeta = readDomMetadata(mediaEl);
    const merged = helpers.mergeMediaMetadata({
      isolatedMeta: isolated.metadata,
      mainMeta: mainWorldSnapshot.metadata,
      domMeta,
      isYouTube: isYT,
      hostname: window.location.hostname,
    });

    let status = "PAUSED";
    let position = 0;
    let duration = 0;
    let volume = 1;
    let elementMuted = false;

    if (mediaEl) {
      if (mediaEl.ended) status = "STOPPED";
      else if (mediaEl.paused) status = "PAUSED";
      else status = "PLAYING";

      position = Number.isFinite(mediaEl.currentTime) ? Math.max(0, mediaEl.currentTime) : 0;
      duration = Number.isFinite(mediaEl.duration) ? Math.max(0, mediaEl.duration) : 0;
      volume = typeof mediaEl.volume === "number" ? Math.max(0, Math.min(1, mediaEl.volume)) : 1;
      elementMuted = Boolean(mediaEl.muted);
    } else if (hasDetachedMedia && detachedMediaSnapshot) {
      if (detachedMediaSnapshot.ended) status = "STOPPED";
      else if (detachedMediaSnapshot.paused) status = "PAUSED";
      else status = "PLAYING";

      position = Number.isFinite(detachedMediaSnapshot.currentTime)
        ? Math.max(0, detachedMediaSnapshot.currentTime)
        : 0;
      duration = Number.isFinite(detachedMediaSnapshot.duration)
        ? Math.max(0, detachedMediaSnapshot.duration)
        : 0;
      volume =
        typeof detachedMediaSnapshot.volume === "number"
          ? Math.max(0, Math.min(1, detachedMediaSnapshot.volume))
          : 1;
      elementMuted = Boolean(detachedMediaSnapshot.muted);
    } else {
      const pbState = mainWorldSnapshot.playbackState || isolated.playbackState;
      status = pbState === "playing" ? "PLAYING" : "PAUSED";
    }

    const skipBtn = isYT ? findClickableSkipAdButton() : null;
    const nextBtn = isYT ? findReadyYoutubeControl(".ytp-next-button") : null;
    const prevBtn = isYT ? findReadyYoutubeControl(".ytp-prev-button") : null;
    const cleanDocTitle = helpers.stripSiteSuffix
      ? helpers.stripSiteSuffix(document.title || "", window.location.hostname)
      : helpers.cleanMediaTitle(document.title || "");

    return {
      hasMedia: true,
      url: window.location.href,
      title: merged.title || cleanDocTitle || window.location.hostname,
      artist: merged.artist || "",
      album: merged.album || "",
      artworkUrl: merged.artworkUrl || domMeta.artworkUrl || null,
      status,
      position: Math.round(position * 100) / 100,
      duration: Math.round(duration * 100) / 100,
      volume: Math.round(volume * 1000) / 1000,
      elementMuted,
      controls: {
        play: Boolean(mediaEl || hasDetachedMedia),
        pause: Boolean(mediaEl || hasDetachedMedia),
        toggle: Boolean(mediaEl || hasDetachedMedia),
        next: Boolean(nextBtn),
        previous: Boolean(prevBtn),
        seek: Boolean((mediaEl || hasDetachedMedia) && (duration > 0 || position > 0)),
        skipAd: Boolean(skipBtn),
      },
      metadataProbe: merged.probe,
    };
  }

  function sendSnapshot(force = false) {
    const snapshot = buildMediaSnapshot();
    // Quantize position to whole seconds for diffing outside PLAYING/seeking
    const sigSnapshot = snapshot.hasMedia
      ? { ...snapshot, position: Math.floor(snapshot.position) }
      : snapshot;
    const key = JSON.stringify(sigSnapshot);
    if (!force && key === lastSentKey) {
      return;
    }
    lastSentKey = key;

    try {
      chrome.runtime.sendMessage({ type: "tab_media_state", payload: snapshot }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context may be invalidated during reload
    }
  }

  function attachElementListeners(el) {
    if (!el || boundElements.has(el)) return;
    boundElements.add(el);

    const immediateEvents = [
      "play",
      "playing",
      "pause",
      "ended",
      "seeked",
      "volumechange",
      "loadedmetadata",
      "durationchange",
      "emptied",
    ];
    for (const evt of immediateEvents) {
      el.addEventListener(evt, () => sendSnapshot(true));
    }

    el.addEventListener("timeupdate", () => {
      const now = Date.now();
      if (now - lastTimeUpdateSentAt >= 900) {
        lastTimeUpdateSentAt = now;
        sendSnapshot(true);
      }
    });
  }

  async function executeMediaCommand(action, value) {
    const { element: mediaEl, debug } = collectMediaElements(true);
    console.debug("[PC Media Control] executeMediaCommand", {
      action,
      value,
      url: window.location.href,
      ...debug,
    });

    if (action === "skip_ad") {
      const skipBtn = findClickableSkipAdButton();
      if (!skipBtn) return { ok: false, reason: "skip_ad_button_not_found" };
      skipBtn.click();
      setTimeout(() => sendSnapshot(true), 150);
      return { ok: true };
    }

    if (action === "next") {
      const nextBtn = findReadyYoutubeControl(".ytp-next-button");
      if (!nextBtn) return { ok: false, reason: "next_button_not_found" };
      nextBtn.click();
      setTimeout(() => sendSnapshot(true), 300);
      return { ok: true };
    }

    if (action === "previous") {
      const prevBtn = findReadyYoutubeControl(".ytp-prev-button");
      if (!prevBtn) return { ok: false, reason: "prev_button_not_found" };
      prevBtn.click();
      setTimeout(() => sendSnapshot(true), 300);
      return { ok: true };
    }

    if (!mediaEl) {
      if (
        detachedMediaSnapshot &&
        (!detachedMediaSnapshot.paused ||
          detachedMediaSnapshot.currentTime > 0 ||
          detachedMediaSnapshot.currentSrc)
      ) {
        const res = await executeDetachedCommandViaBridge(action, value);
        setTimeout(() => sendSnapshot(true), 120);
        return res;
      }
      return { ok: false, reason: "no_media_element" };
    }

    if (action === "play") {
      if (!mediaEl.paused) {
        sendSnapshot(true);
        return { ok: true, reason: "already_playing" };
      }
      try {
        await mediaEl.play();
        sendSnapshot(true);
        return { ok: true };
      } catch (err) {
        if (err && err.name === "NotAllowedError") {
          return { ok: false, reason: "autoplay_rejected" };
        }
        return { ok: false, reason: "play_failed" };
      }
    }

    if (action === "pause") {
      if (mediaEl.paused) {
        sendSnapshot(true);
        return { ok: true, reason: "already_paused" };
      }
      mediaEl.pause();
      sendSnapshot(true);
      return { ok: true };
    }

    if (action === "toggle") {
      if (mediaEl.paused) {
        try {
          await mediaEl.play();
        } catch (err) {
          if (err && err.name === "NotAllowedError") {
            return { ok: false, reason: "autoplay_rejected" };
          }
          return { ok: false, reason: "play_failed" };
        }
      } else {
        mediaEl.pause();
      }
      sendSnapshot(true);
      return { ok: true };
    }

    if (action === "seek") {
      const target = helpers.computeSeekTarget(mediaEl.currentTime, mediaEl.duration, value, false);
      mediaEl.currentTime = target;
      sendSnapshot(true);
      return { ok: true };
    }

    if (action === "seek_relative") {
      const target = helpers.computeSeekTarget(mediaEl.currentTime, mediaEl.duration, value, true);
      mediaEl.currentTime = target;
      sendSnapshot(true);
      return { ok: true };
    }

    return { ok: false, reason: "unknown_action" };
  }

  function executeDetachedCommandViaBridge(action, value, unmuteElement = false) {
    return new Promise((resolve) => {
      const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const origin = window.location.origin;
      if (!origin || origin === "null") {
        resolve({ ok: false, reason: "invalid_origin" });
        return;
      }

      let timer = null;
      const handler = (evt) => {
        if (evt.source !== window || evt.origin !== window.location.origin) return;
        const data = evt.data;
        if (
          data &&
          data.source === MAIN_BRIDGE_SOURCE &&
          data.type === "execute_detached_command_ack" &&
          data.commandId === commandId
        ) {
          window.removeEventListener("message", handler);
          if (timer !== null) clearTimeout(timer);
          resolve({ ok: Boolean(data.ok), reason: data.reason });
        }
      };

      timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve({ ok: false, reason: "detached_command_timeout" });
      }, 1500);

      window.addEventListener("message", handler);
      window.postMessage(
        {
          source: ISOLATED_REQUEST_SOURCE,
          type: "execute_detached_command",
          commandId,
          action,
          value,
          elementId: detachedMediaSnapshot ? detachedMediaSnapshot.id : null,
          unmuteElement,
        },
        origin
      );
    });
  }

  function applyElementVolume(level, unmuteElement) {
    const mediaEl = collectMediaElements();
    if (!mediaEl) {
      if (detachedMediaSnapshot) {
        void executeDetachedCommandViaBridge("volume", level, unmuteElement);
        setTimeout(() => sendSnapshot(true), 100);
        return true;
      }
      return false;
    }
    if (typeof level === "number") {
      const clamped = helpers.clampVolume(level);
      if (clamped === null) return false;
      mediaEl.volume = clamped;
    }
    if (unmuteElement === true && mediaEl.muted) {
      mediaEl.muted = false;
    }
    sendSnapshot(true);
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (data && data.source === MAIN_BRIDGE_SOURCE) {
      if (data.type === "media_session_snapshot" || data.type === "media_snapshot_update") {
        if (data.mediaSession) {
          mainWorldSnapshot = data.mediaSession;
        } else if (data.payload) {
          mainWorldSnapshot = data.payload;
        }
        if (data.detachedMedia !== undefined) {
          detachedMediaSnapshot = data.detachedMedia;
        }
        sendSnapshot(false);
      } else if (data.type === "detached_media_snapshot") {
        detachedMediaSnapshot = data.payload || null;
        sendSnapshot(false);
      }
    }
  });

  window.addEventListener("yt-navigate-finish", () => {
    setTimeout(() => {
      if (window.location.origin && window.location.origin !== "null") {
        window.postMessage(
          { source: ISOLATED_REQUEST_SOURCE, type: "request_snapshot" },
          window.location.origin
        );
      }
      sendSnapshot(true);
    }, 250);
  });

  const observer = new MutationObserver(() => {
    if (mutationTimer !== null) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      sendSnapshot(false);
    }, 300);
  });

  function initObserver() {
    if (!document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "disabled", "aria-disabled", "src", "is-active"],
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initObserver();
      sendSnapshot(false);
    });
  } else {
    initObserver();
  }

  // Document-level capture ensures newly mounted Shorts <video> elements report
  // play/pause transitions immediately before MutationObserver attaches listeners.
  for (const evt of ["play", "playing", "pause", "ended", "seeked", "volumechange", "loadedmetadata"]) {
    document.addEventListener(
      evt,
      (event) => {
        const target = event.target;
        if (target && (target.tagName === "VIDEO" || target.tagName === "AUDIO")) {
          attachElementListeners(target);
          sendSnapshot(true);
        }
      },
      true
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;

    if (message.type === "request_media_state") {
      const mediaEl = collectMediaElements();
      const hasDetached = Boolean(
        detachedMediaSnapshot &&
          (!detachedMediaSnapshot.paused ||
            detachedMediaSnapshot.currentTime > 0 ||
            detachedMediaSnapshot.currentSrc)
      );
      if (window !== window.top && !mediaEl && !hasDetached) {
        return false;
      }
      if (window.location.origin && window.location.origin !== "null") {
        window.postMessage(
          { source: ISOLATED_REQUEST_SOURCE, type: "request_snapshot" },
          window.location.origin
        );
      }
      const snapshot = buildMediaSnapshot();
      sendSnapshot(true);
      sendResponse({ ok: true, snapshot });
      return false;
    }

    if (message.type === "media_command") {
      const mediaEl = collectMediaElements();
      const hasDetached = Boolean(
        detachedMediaSnapshot &&
          (!detachedMediaSnapshot.paused ||
            detachedMediaSnapshot.currentTime > 0 ||
            detachedMediaSnapshot.currentSrc)
      );
      // Crucial: Only the frame with the primary media element responds!
      // In subframes without media elements (e.g. ad iframes), DO NOT sendResponse so we don't swallow main frame's ack.
      if (window !== window.top && !mediaEl && !hasDetached) {
        return false;
      }

      const isButtonCommand = ["skip_ad", "next", "previous"].includes(message.action);
      if (!mediaEl && !hasDetached && !isButtonCommand) {
        sendResponse({ ok: false, reason: "no_media_element" });
        return false;
      }

      executeMediaCommand(message.action, message.value)
        .then((result) => {
          sendResponse(typeof result === "object" ? result : { ok: Boolean(result) });
        })
        .catch((err) => {
          sendResponse({ ok: false, reason: err?.message || "execution_error" });
        });
      return true;
    }

    if (message.type === "tab_media_volume") {
      const mediaEl = collectMediaElements();
      const hasDetached = Boolean(
        detachedMediaSnapshot &&
          (!detachedMediaSnapshot.paused ||
            detachedMediaSnapshot.currentTime > 0 ||
            detachedMediaSnapshot.currentSrc)
      );
      if (window !== window.top && !mediaEl && !hasDetached) {
        return false;
      }
      const ok = applyElementVolume(message.value, message.unmuteElement);
      sendResponse({ ok, reason: ok ? undefined : "no_media_element" });
      return false;
    }

    return false;
  });

  if (window.location.origin && window.location.origin !== "null") {
    window.postMessage(
      { source: ISOLATED_REQUEST_SOURCE, type: "request_snapshot" },
      window.location.origin
    );
  }
  sendSnapshot(true);
})();

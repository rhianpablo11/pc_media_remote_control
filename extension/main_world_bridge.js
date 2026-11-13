/**
 * Runs in the page's MAIN execution world at document_start.
 * 1. Reads navigator.mediaSession.metadata and playbackState.
 * 2. Patches window.Audio, Document.prototype.createElement, and
 *    HTMLMediaElement.prototype.play to track detached media elements (e.g. Howler.js / Sua Música).
 * 3. Bridges snapshots and remote playback/volume commands to/from the ISOLATED world.
 */
(function initPcMediaMainWorldBridge() {
  "use strict";

  if (window.__pcMediaMainBridgeInstalled) {
    return;
  }
  window.__pcMediaMainBridgeInstalled = true;

  const BRIDGE_SOURCE = "pc-media-control-main";
  const REQUEST_SOURCE = "pc-media-control-isolated";

  const trackedElements = new Set();
  let nextElementId = 1;
  let lastSerialized = "";

  function trackElement(el, source) {
    if (!el || !(el instanceof HTMLMediaElement)) {
      return;
    }
    if (trackedElements.has(el)) {
      return;
    }
    if (trackedElements.size >= 40) {
      for (const candidate of trackedElements) {
        if (!candidate.isConnected && candidate.paused && (candidate.ended || candidate.readyState === 0)) {
          trackedElements.delete(candidate);
        }
      }
    }

    trackedElements.add(el);
    if (!el.__pcMediaBridgeId) {
      el.__pcMediaBridgeId = `bridge_media_${nextElementId++}`;
    }

    bindElementListeners(el);
    setTimeout(() => postSnapshot(false), 50);
  }

  function bindElementListeners(el) {
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
      el.addEventListener(
        evt,
        () => {
          postSnapshot(false);
        },
        true
      );
    }

    let lastTimeUpdate = 0;
    el.addEventListener(
      "timeupdate",
      () => {
        const now = Date.now();
        if (now - lastTimeUpdate >= 900) {
          lastTimeUpdate = now;
          postSnapshot(false);
        }
      },
      true
    );
  }

  // Intercept window.Audio constructor
  const OriginalAudio = window.Audio;
  if (typeof OriginalAudio === "function") {
    function TrackedAudio(...args) {
      const instance = new OriginalAudio(...args);
      trackElement(instance, "audio_constructor");
      return instance;
    }
    TrackedAudio.prototype = OriginalAudio.prototype;
    try {
      Object.setPrototypeOf(TrackedAudio, OriginalAudio);
    } catch {
      // Ignore if prototype chaining is restricted
    }
    window.Audio = TrackedAudio;
  }

  // Intercept Document.prototype.createElement
  if (typeof Document !== "undefined" && Document.prototype && Document.prototype.createElement) {
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function (tagName, options) {
      const el = originalCreateElement.call(this, tagName, options);
      if (typeof tagName === "string") {
        const lower = tagName.toLowerCase();
        if (lower === "audio" || lower === "video") {
          trackElement(el, "create_element");
        }
      }
      return el;
    };
  }

  // Intercept HTMLMediaElement.prototype.play
  if (
    typeof HTMLMediaElement !== "undefined" &&
    HTMLMediaElement.prototype &&
    HTMLMediaElement.prototype.play
  ) {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      trackElement(this, "play_method");
      return originalPlay.apply(this, arguments);
    };
  }

  function serializeMetadata() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession) {
      return { metadata: null, playbackState: "none" };
    }
    const raw = navigator.mediaSession.metadata;
    const metadata = raw
      ? {
          title: typeof raw.title === "string" ? raw.title : "",
          artist: typeof raw.artist === "string" ? raw.artist : "",
          album: typeof raw.album === "string" ? raw.album : "",
          artwork: Array.isArray(raw.artwork)
            ? raw.artwork.map((item) => ({
                src: item && typeof item.src === "string" ? item.src : "",
                sizes: item && typeof item.sizes === "string" ? item.sizes : "",
                type: item && typeof item.type === "string" ? item.type : "",
              }))
            : [],
        }
      : null;

    return {
      metadata,
      playbackState: navigator.mediaSession.playbackState || "none",
    };
  }

  function getActiveTrackedElement() {
    // 1. Actively playing element (prefer longer duration/music over sound effects)
    const playing = [];
    for (const el of trackedElements) {
      if (!el.paused && !el.ended) {
        playing.push(el);
      }
    }
    if (playing.length > 0) {
      playing.sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0));
      return playing[0];
    }

    // 2. Paused element with positive currentTime or duration
    for (const el of trackedElements) {
      if (el.currentTime > 0 || (Number.isFinite(el.duration) && el.duration > 0)) {
        return el;
      }
    }

    // 3. Fallback to any tracked element
    for (const el of trackedElements) {
      return el;
    }
    return null;
  }

  function serializeDetachedMedia() {
    const active = getActiveTrackedElement();
    if (!active) {
      return null;
    }
    return {
      id: active.__pcMediaBridgeId,
      isDetached: !active.isConnected,
      tagName: active.tagName || "AUDIO",
      paused: Boolean(active.paused),
      ended: Boolean(active.ended),
      currentTime: Number.isFinite(active.currentTime) ? active.currentTime : 0,
      duration: Number.isFinite(active.duration) ? active.duration : 0,
      volume: typeof active.volume === "number" ? active.volume : 1,
      muted: Boolean(active.muted),
      readyState: active.readyState || 0,
      currentSrc: active.currentSrc || active.src || "",
    };
  }

  function postSnapshot(force = false) {
    const origin = window.location.origin;
    if (!origin || origin === "null") {
      return;
    }
    const metaSnapshot = serializeMetadata();
    const detachedSnapshot = serializeDetachedMedia();

    const compound = {
      mediaSession: metaSnapshot,
      detachedMedia: detachedSnapshot,
    };
    const serialized = JSON.stringify(compound);
    if (!force && serialized === lastSerialized) {
      return;
    }
    lastSerialized = serialized;

    // Send unified snapshot to ISOLATED world
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "media_snapshot_update",
        payload: metaSnapshot, // legacy compatibility
        mediaSession: metaSnapshot,
        detachedMedia: detachedSnapshot,
      },
      origin
    );
  }

  function sendAck(commandId, ok, reason) {
    const origin = window.location.origin;
    if (!origin || origin === "null") {
      return;
    }
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "execute_detached_command_ack",
        commandId,
        ok: Boolean(ok),
        reason: reason || undefined,
      },
      origin
    );
  }

  async function handleDetachedCommand({ commandId, action, value, elementId, unmuteElement }) {
    let target = null;
    if (elementId) {
      for (const el of trackedElements) {
        if (el.__pcMediaBridgeId === elementId) {
          target = el;
          break;
        }
      }
    }
    if (!target) {
      target = getActiveTrackedElement();
    }

    if (!target) {
      sendAck(commandId, false, "no_media_element");
      return;
    }

    try {
      if (action === "play") {
        if (!target.paused) {
          sendAck(commandId, true, "already_playing");
          return;
        }
        await target.play();
        sendAck(commandId, true);
        postSnapshot(true);
        return;
      }

      if (action === "pause") {
        if (target.paused) {
          sendAck(commandId, true, "already_paused");
          return;
        }
        target.pause();
        sendAck(commandId, true);
        postSnapshot(true);
        return;
      }

      if (action === "toggle") {
        if (target.paused) {
          await target.play();
        } else {
          target.pause();
        }
        sendAck(commandId, true);
        postSnapshot(true);
        return;
      }

      if (action === "seek") {
        const num = Number(value);
        if (Number.isFinite(num)) {
          const maxDur = Number.isFinite(target.duration) && target.duration > 0 ? target.duration : Infinity;
          target.currentTime = Math.max(0, Math.min(maxDur, num));
        }
        sendAck(commandId, true);
        postSnapshot(true);
        return;
      }

      if (action === "seek_relative") {
        const delta = Number(value);
        if (Number.isFinite(delta)) {
          const cur = Number.isFinite(target.currentTime) ? target.currentTime : 0;
          const maxDur = Number.isFinite(target.duration) && target.duration > 0 ? target.duration : Infinity;
          target.currentTime = Math.max(0, Math.min(maxDur, cur + delta));
        }
        sendAck(commandId, true);
        postSnapshot(true);
        return;
      }

      if (action === "volume") {
        if (typeof value === "number" && Number.isFinite(value)) {
          target.volume = Math.max(0, Math.min(1, value));
        }
        if (unmuteElement === true) {
          target.muted = false;
        }
        sendAck(commandId, true);
        postSnapshot(true);
        return;
      }

      sendAck(commandId, false, "unknown_action");
    } catch (err) {
      sendAck(commandId, false, err && err.name ? err.name : "command_failed");
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== REQUEST_SOURCE) {
      return;
    }
    if (data.type === "request_snapshot") {
      postSnapshot(true);
      return;
    }
    if (data.type === "execute_detached_command") {
      void handleDetachedCommand(data);
    }
  });

  // Global capture listeners ensure document-level media events trigger snapshot updates
  for (const evt of ["play", "playing", "pause", "loadedmetadata", "durationchange"]) {
    document.addEventListener(
      evt,
      () => {
        setTimeout(() => postSnapshot(false), 80);
      },
      true
    );
  }

  // Lightweight polling catches SPA metadata updates (e.g. YouTube navigation)
  setInterval(() => {
    if (trackedElements.size > 0 || (document.querySelector && document.querySelector("video, audio"))) {
      postSnapshot(false);
    }
  }, 1000);

  postSnapshot(true);
})();

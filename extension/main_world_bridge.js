/**
 * Runs in the page's MAIN execution world so navigator.mediaSession.metadata
 * populated by sites like YouTube/Spotify Web can be read and bridged safely
 * to the extension's ISOLATED content script via window.postMessage.
 */
(function initPcMediaMainWorldBridge() {
  "use strict";

  if (window.__pcMediaMainBridgeInstalled) {
    return;
  }
  window.__pcMediaMainBridgeInstalled = true;

  const BRIDGE_SOURCE = "pc-media-control-main";
  const REQUEST_SOURCE = "pc-media-control-isolated";
  let lastSerialized = "";

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

  function postSnapshot(force = false) {
    const origin = window.location.origin;
    if (!origin || origin === "null") {
      return;
    }
    const snapshot = serializeMetadata();
    const serialized = JSON.stringify(snapshot);
    if (!force && serialized === lastSerialized) {
      return;
    }
    lastSerialized = serialized;
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "media_session_snapshot",
        payload: snapshot,
      },
      origin
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (data && data.source === REQUEST_SOURCE && data.type === "request_snapshot") {
      postSnapshot(true);
    }
  });

  for (const evt of ["play", "playing", "pause", "loadedmetadata", "durationchange"]) {
    document.addEventListener(
      evt,
      () => {
        setTimeout(() => postSnapshot(false), 120);
      },
      true
    );
  }

  // Lightweight polling catches SPA metadata updates (e.g. YouTube navigation)
  setInterval(() => {
    if (document.querySelector("video, audio")) {
      postSnapshot(false);
    }
  }, 1000);

  postSnapshot(true);
})();

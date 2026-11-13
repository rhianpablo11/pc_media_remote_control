/**
 * Parser modular para resultados de busca do YouTube extraídos do HTML (ytInitialData).
 * Não depende de API externa nem de chaves de autenticação.
 */

export const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

/**
 * Valida se uma string é um ID de vídeo válido do YouTube (11 caracteres alfanuméricos com hífens/sublinhados).
 * @param {any} id
 * @returns {boolean}
 */
export function isValidVideoId(id) {
  return typeof id === "string" && VIDEO_ID_REGEX.test(id.trim());
}

/**
 * Extrai o objeto ytInitialData embutido no HTML da página de busca do YouTube.
 * @param {string} html
 * @returns {object|null}
 */
export function extractYtInitialData(html) {
  if (!html || typeof html !== "string") {
    return null;
  }

  // 1. Procura var ytInitialData = { ... };</script>
  const varPattern = /(?:var\s+ytInitialData\s*=\s*|window\[["']ytInitialData["']\]\s*=\s*|ytInitialData\s*=\s*)({.+?});\s*<\/script>/s;
  const match = html.match(varPattern);
  if (match && match[1]) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // continua tentando estratégias alternativas
    }
  }

  // 2. Busca por padrão sem tag de script fechada explícita
  const fallbackPattern = /(?:var\s+ytInitialData\s*=\s*|ytInitialData\s*=\s*)({.+?});/s;
  const matchFallback = html.match(fallbackPattern);
  if (matchFallback && matchFallback[1]) {
    try {
      return JSON.parse(matchFallback[1]);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Extrai texto a partir da estrutura runs ou simpleText comum no JSON do YouTube.
 * @param {object} obj
 * @returns {string}
 */
function extractText(obj) {
  if (!obj) return "";
  if (typeof obj.simpleText === "string") {
    return obj.simpleText.trim();
  }
  if (Array.isArray(obj.runs)) {
    return obj.runs.map((r) => r?.text || "").join("").trim();
  }
  return "";
}

/**
 * Escolhe a melhor URL de miniatura disponível (prioriza resolução maior).
 * @param {Array<{url: string, width?: number, height?: number}>} thumbnails
 * @returns {string}
 */
function pickBestThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
    return "";
  }
  // Normalmente o último elemento é a maior resolução
  const last = thumbnails[thumbnails.length - 1];
  let url = last?.url || thumbnails[0]?.url || "";
  if (url.startsWith("//")) {
    url = "https:" + url;
  }
  return url;
}

/**
 * Processa o JSON ytInitialData e retorna uma lista limpa de resultados de vídeos.
 * Ignora anúncios, canais, playlists e itens que não são vídeos para reprodução.
 * @param {object} ytData
 * @param {number} maxResults
 * @returns {Array<{id: string, title: string, channel: string, duration: string, views: string, thumbnail: string, isLive: boolean, isShorts: boolean}>}
 */
export function parseSearchResults(ytData, maxResults = 25) {
  if (!ytData || typeof ytData !== "object") {
    return [];
  }

  const results = [];
  const sectionList =
    ytData?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents || [];

  for (const section of sectionList) {
    const items = section?.itemSectionRenderer?.contents || [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      // Ignora anúncios patrocinados explicitamente
      if (item.adSlotRenderer || item.promotedVideoRenderer || item.displayAdRenderer) {
        continue;
      }

      // Ignora canais e playlists (foco exclusivo em vídeos para tocar)
      if (item.channelRenderer || item.playlistRenderer) {
        continue;
      }

      // Processa vídeo padrão
      if (item.videoRenderer) {
        const vr = item.videoRenderer;
        const videoId = vr.videoId;

        if (!isValidVideoId(videoId)) {
          continue;
        }

        const title = extractText(vr.title);
        const channel = extractText(vr.ownerText || vr.shortBylineText);
        let duration = extractText(vr.lengthText);
        const views = extractText(vr.viewCountText || vr.shortViewCountText);
        const thumbnail = pickBestThumbnail(vr.thumbnail?.thumbnails);

        // Checa se é transmissão ao vivo
        let isLive = false;
        const badges = Array.isArray(vr.badges) ? vr.badges : [];
        for (const badge of badges) {
          const label = extractText(badge?.metadataBadgeRenderer?.label).toUpperCase();
          if (label.includes("AO VIVO") || label.includes("LIVE") || badge?.metadataBadgeRenderer?.style === "BADGE_STYLE_TYPE_LIVE_NOW") {
            isLive = true;
            break;
          }
        }

        if (isLive && !duration) {
          duration = "Ao vivo";
        }

        // Checa se é Shorts
        const isShorts = vr?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url?.includes("/shorts/");

        results.push({
          id: videoId,
          title,
          channel,
          duration,
          views,
          thumbnail,
          isLive,
          isShorts: Boolean(isShorts),
        });

        if (results.length >= maxResults) {
          return results;
        }
      }

      // Prateleiras de Shorts (shelfRenderer)
      if (item.shelfRenderer) {
        const shelf = item.shelfRenderer;
        const shelfTitle = extractText(shelf.title).toLowerCase();
        const shelfItems = shelf?.content?.verticalListRenderer?.items || [];

        if (shelfTitle.includes("shorts")) {
          for (const sItem of shelfItems) {
            const svr = sItem?.shortsLockupViewModel || sItem?.videoRenderer;
            const sId = svr?.entityId || svr?.videoId;
            if (isValidVideoId(sId)) {
              const sTitle = extractText(svr.headline || svr.title);
              results.push({
                id: sId,
                title: sTitle,
                channel: "YouTube Shorts",
                duration: "Shorts",
                views: "",
                thumbnail: pickBestThumbnail(svr?.thumbnail?.thumbnails),
                isLive: false,
                isShorts: true,
              });
            }
          }
        }
      }
    }
  }

  return results;
}

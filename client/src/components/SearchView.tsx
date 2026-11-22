import { useEffect, useState, type FormEvent } from "react";
import type { SearchResultItem } from "../types";
import { triggerHaptic } from "../utils";
import {
  CloseIcon,
  FullscreenIcon,
  MusicNoteIcon,
  PlayIcon,
  SearchIcon,
} from "./Icons";

interface SearchViewProps {
  extensionConnected: boolean;
  onSearch: (query: string) => Promise<{
    ok: boolean;
    query: string;
    results: SearchResultItem[];
    fallbackUrl?: string | null;
    error?: string | null;
  }>;
  onPlayVideo: (
    videoId: string,
    opts?: { mode?: "current_tab" | "new_tab"; fullscreen?: boolean },
  ) => void;
  onOpenFallback: (query: string) => void;
}

const SEARCH_HISTORY_KEY = "pc_media_search_history";
const MAX_HISTORY_ITEMS = 8;

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_ITEMS) : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(history: string[]): void {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)));
  } catch {
    // Ignore storage quota errors
  }
}

export function SearchView({
  extensionConnected,
  onSearch,
  onPlayVideo,
  onOpenFallback,
}: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(() => loadSearchHistory());
  const [openFullscreen, setOpenFullscreen] = useState(true);
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);

  useEffect(() => {
    saveSearchHistory(history);
  }, [history]);

  const executeSearch = async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;

    triggerHaptic(8);
    setIsSearching(true);
    setLastError(null);
    setHasSearched(true);

    // Add to search history at the beginning (unique)
    setHistory((prev) => [trimmed, ...prev.filter((item) => item.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX_HISTORY_ITEMS));

    try {
      const resp = await onSearch(trimmed);
      if (resp.ok) {
        setResults(resp.results || []);
        setLastError(null);
      } else {
        setResults([]);
        setLastError(resp.error || "Não foi possível carregar os resultados do YouTube.");
      }
    } catch (err: unknown) {
      setResults([]);
      const msg = err instanceof Error ? err.message : "Erro inesperado na busca.";
      setLastError(msg);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void executeSearch(query);
  };

  const handleChipClick = (term: string) => {
    setQuery(term);
    void executeSearch(term);
  };

  const handleClearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(SEARCH_HISTORY_KEY);
    } catch {
      // Ignore
    }
  };

  const handlePlay = (videoId: string, mode: "current_tab" | "new_tab") => {
    setPlayingVideoId(videoId);
    onPlayVideo(videoId, { mode, fullscreen: openFullscreen });
    setTimeout(() => setPlayingVideoId(null), 1200);
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* Search Header & Input Card */}
      <section className="card-surface p-4 sm:p-5">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              type="search"
              name="youtube-query"
              autoComplete="off"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar vídeos no YouTube..."
              aria-label="Buscar vídeos no YouTube"
              className={`field-input min-h-[46px] w-full rounded-2xl pl-10 text-sm font-medium ${query ? "pr-11" : "pr-3.5"}`}
            />
            <SearchIcon
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-55"
              style={{ color: "var(--text)" }}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Limpar texto da busca"
                className="touch-btn absolute right-0.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full opacity-70 hover:opacity-100"
                style={{ color: "var(--text-secondary)" }}
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <button
            type="submit"
            aria-label="Pesquisar vídeos"
            disabled={isSearching || !query.trim()}
            className="touch-btn btn-primary shrink-0 rounded-2xl px-4 text-sm font-semibold"
          >
            {isSearching ? "Buscando…" : "Buscar"}
          </button>
        </form>

        {/* Fullscreen Option Toggle */}
        <div
          className="mt-3 flex min-h-[44px] items-center justify-between border-t pt-2"
          style={{ borderColor: "var(--hairline)" }}
        >
          <label
            className="flex min-h-[44px] flex-1 cursor-pointer select-none items-center gap-2.5 text-xs font-medium"
            style={{ color: "var(--text-secondary)" }}
          >
            <input
              type="checkbox"
              checked={openFullscreen}
              onChange={(e) => setOpenFullscreen(e.target.checked)}
              className="h-4 w-4 rounded accent-[var(--accent)]"
            />
            <span className="flex items-center gap-1.5">
              <FullscreenIcon className="h-3.5 w-3.5" />
              <span>Abrir vídeo em tela cheia</span>
            </span>
          </label>

          {!extensionConnected ? (
            <span className="shrink-0 text-xs font-medium" style={{ color: "var(--warn)" }}>
              Extensão offline
            </span>
          ) : null}
        </div>

        {/* Recent Search History Chips */}
        {history.length > 0 ? (
          <div className="mt-2 border-t pt-2.5" style={{ borderColor: "var(--hairline)" }}>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>
                Buscas recentes
              </span>
              <button
                type="button"
                onClick={handleClearHistory}
                className="touch-btn -my-1.5 rounded-lg px-2 text-xs font-medium hover:underline"
                style={{ color: "var(--text-secondary)" }}
              >
                Limpar
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {history.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => handleChipClick(item)}
                  className="touch-btn inline-flex items-center rounded-full px-3.5 py-1.5 text-xs font-medium"
                  style={{
                    backgroundColor: "var(--surface-elevated)",
                    color: "var(--text)",
                    border: "1px solid var(--hairline)",
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* State: Searching / Loading */}
      {isSearching ? (
        <section className="card-surface flex flex-col items-center py-14 text-center" aria-live="polite">
          <div
            className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
            style={{
              borderColor: "var(--accent)",
              borderTopColor: "transparent",
            }}
            aria-hidden="true"
          />
          <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Buscando vídeos no YouTube…
          </p>
        </section>
      ) : null}

      {/* State: Error with Graceful Fallback */}
      {!isSearching && lastError ? (
        <section className="card-surface p-5 text-center" role="alert">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
            style={{
              backgroundColor: "var(--danger-soft)",
              border: "1px solid var(--hairline)",
              color: "var(--danger)",
            }}
          >
            <CloseIcon className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Falha na busca
          </h3>
          <p className="mx-auto mt-1 max-w-[32ch] text-xs text-pretty" style={{ color: "var(--text-secondary)" }}>
            {lastError}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => onOpenFallback(query)}
              className="touch-btn rounded-2xl px-4 py-2.5 text-xs font-semibold"
              style={{
                backgroundColor: "var(--accent-soft)",
                border: "1px solid var(--hairline)",
                color: "var(--accent-text)",
              }}
            >
              Abrir busca no notebook
            </button>
            <button
              type="button"
              onClick={() => void executeSearch(query)}
              className="touch-btn rounded-2xl px-4 py-2.5 text-xs font-medium"
              style={{
                backgroundColor: "var(--surface-elevated)",
                color: "var(--text)",
                border: "1px solid var(--hairline)",
              }}
            >
              Tentar novamente
            </button>
          </div>
        </section>
      ) : null}

      {/* State: Empty Search Initial State */}
      {!isSearching && !hasSearched && (
        <section className="card-surface flex flex-col items-center px-5 py-12 text-center">
          <div
            className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border"
            style={{
              backgroundColor: "var(--surface-elevated)",
              borderColor: "var(--hairline)",
              color: "var(--text-secondary)",
            }}
          >
            <SearchIcon className="h-7 w-7 opacity-75" />
          </div>
          <h3 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Buscar e Tocar Vídeos
          </h3>
          <p className="mt-1.5 max-w-[32ch] text-xs leading-relaxed text-pretty" style={{ color: "var(--text-secondary)" }}>
            Pesquise no YouTube a partir do celular e toque diretamente no computador sem olhar o monitor.
          </p>
        </section>
      )}

      {/* State: No Results */}
      {!isSearching && hasSearched && !lastError && results.length === 0 && (
        <section className="card-surface flex flex-col items-center px-5 py-10 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            Nenhum vídeo encontrado
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Tente outros termos de pesquisa.
          </p>
          <button
            type="button"
            onClick={() => onOpenFallback(query)}
            className="touch-btn mt-3 rounded-2xl px-4 py-2 text-xs font-medium"
            style={{
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid var(--hairline)",
              color: "var(--accent-text)",
            }}
          >
            Abrir busca no notebook
          </button>
        </section>
      )}

      {/* State: Results List */}
      {!isSearching && results.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--text-secondary)" }}>
              {results.length} resultados encontrados
            </span>
          </div>

          {results.map((video) => {
            const isPlayingThis = playingVideoId === video.id;

            return (
              <article
                key={video.id}
                className="card-surface card-interactive overflow-hidden rounded-[20px] p-3"
              >
                <div className="flex gap-3">
                  {/* Video Thumbnail (16:9), nested 12px radius inside 20px card */}
                  <div
                    className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-[12px]"
                    style={{
                      backgroundColor: "var(--surface-elevated)",
                      border: "1px solid var(--hairline)",
                    }}
                  >
                    {video.thumbnail ? (
                      <img
                        src={video.thumbnail}
                        alt={video.title}
                        width={128}
                        height={72}
                        decoding="async"
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center opacity-40">
                        <MusicNoteIcon className="h-6 w-6" />
                      </div>
                    )}

                    {/* Duration / Live Badge */}
                    {video.isLive ? (
                      <span
                        className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
                        style={{ backgroundColor: "var(--pill-live-bg)" }}
                      >
                        AO VIVO
                      </span>
                    ) : video.duration ? (
                      <span
                        className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums"
                        style={{ backgroundColor: "var(--pill-duration-bg)" }}
                      >
                        {video.duration}
                      </span>
                    ) : null}
                  </div>

                  {/* Video Info */}
                  <div className="flex min-w-0 flex-1 flex-col justify-between">
                    <div>
                      <h4
                        className="line-clamp-2 text-sm font-semibold leading-tight tracking-tight"
                        style={{ color: "var(--text)" }}
                        title={video.title}
                      >
                        {video.title}
                      </h4>
                      <p
                        className="mt-1 truncate text-xs font-medium"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {video.channel || "YouTube"}
                      </p>
                      {video.views ? (
                        <p
                          className="truncate text-xs tabular-nums"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {video.views}
                        </p>
                      ) : null}
                    </div>

                    {/* Action Buttons */}
                    <div className="mt-2.5 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handlePlay(video.id, "current_tab")}
                        className="touch-btn inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold"
                        style={{
                          backgroundColor: isPlayingThis ? "var(--ok)" : "var(--accent)",
                          color: "var(--accent-contrast)",
                        }}
                      >
                        <PlayIcon className="h-3.5 w-3.5" />
                        <span>{isPlayingThis ? "Tocando…" : "Tocar agora"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handlePlay(video.id, "new_tab")}
                        className="touch-btn inline-flex items-center rounded-xl px-3 py-1.5 text-xs font-medium"
                        style={{
                          backgroundColor: "var(--surface-elevated)",
                          color: "var(--text)",
                          border: "1px solid var(--hairline)",
                        }}
                      >
                        Nova aba
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

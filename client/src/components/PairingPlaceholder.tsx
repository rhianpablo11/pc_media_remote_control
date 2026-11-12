interface PairingPlaceholderProps {
  onRetry: () => void;
}

export function PairingPlaceholder({ onRetry }: PairingPlaceholderProps) {
  return (
    <section className="card-surface flex flex-col items-center p-6 text-center">
      <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
        Dispositivo não pareado
      </h2>
      <p className="mt-2 max-w-[30ch] text-sm" style={{ color: "var(--text-secondary)" }}>
        Este aparelho ainda não foi autorizado pelo host no PC. Conclua o pareamento pelo QR code
        quando a Fase 4 estiver ativa.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="touch-btn mt-5 rounded-2xl px-5 text-sm font-semibold"
        style={{
          backgroundColor: "var(--accent)",
          color: "var(--accent-contrast)",
        }}
      >
        Tentar novamente
      </button>
    </section>
  );
}

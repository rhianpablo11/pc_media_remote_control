import { useState, type FormEvent } from "react";

interface PairingPlaceholderProps {
  onRetry: () => void;
  onPairWithPin: (pin: string) => Promise<{ ok: boolean; error?: string }>;
}

export function PairingPlaceholder({ onRetry, onPairWithPin }: PairingPlaceholderProps) {
  const [pin, setPin] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanPin = pin.trim().replace(/\s+/g, "");
    if (!cleanPin) {
      setLocalError("Digite o código PIN de 6 dígitos.");
      return;
    }
    if (cleanPin.length !== 6 || !/^\d+$/.test(cleanPin)) {
      setLocalError("O PIN deve conter exatamente 6 números.");
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    try {
      const res = await onPairWithPin(cleanPin);
      if (!res.ok) {
        setLocalError(res.error || "Código ou PIN inválido ou expirado.");
      } else {
        setPin("");
      }
    } catch {
      setLocalError("Erro ao tentar conectar com o servidor.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="card-surface mx-auto mt-2 flex w-full max-w-[390px] flex-col items-center p-6 text-center">
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border"
        style={{
          backgroundColor: "var(--accent-soft)",
          borderColor: "var(--hairline)",
          color: "var(--accent-text)",
        }}
      >
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>

      <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--text)" }}>
        Dispositivo não pareado
      </h2>
      <p className="mt-2 max-w-[34ch] text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        Para controlar a mídia na rede local, escaneie o <strong>QR code</strong> exibido no PC ou digite o <strong>PIN de 6 dígitos</strong>.
      </p>

      {localError ? (
        <div
          role="alert"
          aria-live="polite"
          className="mt-4 w-full rounded-2xl px-3.5 py-2.5 text-xs font-medium"
          style={{
            backgroundColor: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger)",
          }}
        >
          {localError}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-6 flex w-full flex-col gap-3">
        <label htmlFor="pin-input" className="sr-only">
          PIN de 6 dígitos
        </label>
        <input
          id="pin-input"
          name="pin"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={6}
          value={pin}
          onChange={(e) => {
            const val = e.target.value.replace(/\D/g, "").slice(0, 6);
            setPin(val);
            if (localError) setLocalError(null);
          }}
          placeholder="000000"
          className="field-input min-h-[54px] w-full rounded-2xl pl-[0.4em] text-center font-mono text-2xl font-bold tracking-[0.4em] tabular-nums"
        />

        <button
          type="submit"
          disabled={isSubmitting || pin.length < 6}
          className="touch-btn btn-primary min-h-[48px] w-full rounded-2xl text-sm font-semibold"
        >
          {isSubmitting ? "Pareando…" : "Parear com PIN"}
        </button>
      </form>

      <button
        type="button"
        onClick={onRetry}
        className="touch-btn mt-3 min-h-[44px] w-full rounded-2xl text-xs font-semibold"
        style={{
          backgroundColor: "transparent",
          color: "var(--text-secondary)",
        }}
      >
        Tentar reconectar
      </button>
    </section>
  );
}

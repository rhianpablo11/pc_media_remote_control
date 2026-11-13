import { useCallback, useEffect, useRef, useState } from "react";

interface UseOptimisticSliderOptions {
  serverValue: number;
  onCommit: (value: number) => void;
  throttleMs?: number;
  lockDurationMs?: number;
}

export function useOptimisticSlider({
  serverValue,
  onCommit,
  throttleMs = 70,
  lockDurationMs = 400,
}: UseOptimisticSliderOptions) {
  const [localValue, setLocalValue] = useState<number>(serverValue);
  const isDraggingRef = useRef<boolean>(false);
  const lastSentTimeRef = useRef<number>(0);
  const pendingValueRef = useRef<number | null>(null);
  const throttleTimerRef = useRef<number | null>(null);
  const lockUntilRef = useRef<number>(0);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // When serverValue updates from WebSocket, sync localValue ONLY if not dragging and not locked
  useEffect(() => {
    if (!isDraggingRef.current && Date.now() >= lockUntilRef.current) {
      setLocalValue(serverValue);
    }
  }, [serverValue]);

  const clearThrottle = useCallback(() => {
    if (throttleTimerRef.current !== null) {
      window.clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
  }, []);

  const sendImmediate = useCallback((val: number) => {
    lastSentTimeRef.current = Date.now();
    pendingValueRef.current = null;
    onCommitRef.current(val);
  }, []);

  const handlePointerDown = useCallback(() => {
    isDraggingRef.current = true;
    clearThrottle();
  }, [clearThrottle]);

  const handleChange = useCallback(
    (val: number) => {
      setLocalValue(val);
      const now = Date.now();
      const elapsed = now - lastSentTimeRef.current;

      if (elapsed >= throttleMs) {
        clearThrottle();
        sendImmediate(val);
      } else {
        pendingValueRef.current = val;
        if (throttleTimerRef.current === null) {
          throttleTimerRef.current = window.setTimeout(() => {
            throttleTimerRef.current = null;
            if (pendingValueRef.current !== null) {
              sendImmediate(pendingValueRef.current);
            }
          }, throttleMs - elapsed);
        }
      }
    },
    [throttleMs, clearThrottle, sendImmediate],
  );

  const handlePointerUp = useCallback(
    (finalVal?: number) => {
      isDraggingRef.current = false;
      clearThrottle();
      const valueToSend =
        finalVal !== undefined ? finalVal : (pendingValueRef.current ?? localValue);
      setLocalValue(valueToSend);
      sendImmediate(valueToSend);
      // Ignore server echoes for lockDurationMs so old state packets don't cause slider jump
      lockUntilRef.current = Date.now() + lockDurationMs;
    },
    [localValue, lockDurationMs, clearThrottle, sendImmediate],
  );

  useEffect(() => {
    return () => {
      clearThrottle();
    };
  }, [clearThrottle]);

  return {
    value: localValue,
    setValue: setLocalValue,
    onPointerDown: handlePointerDown,
    onChange: handleChange,
    onPointerUp: handlePointerUp,
  };
}

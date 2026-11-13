"""Single-instance protection using a Windows Named Mutex."""

from __future__ import annotations

import ctypes
import logging
from ctypes import wintypes

logger = logging.getLogger(__name__)

MUTEX_NAME = "Global\\PCMediaControl_SingleInstance_Mutex"
ERROR_ALREADY_EXISTS = 183


class SingleInstanceLock:
    """Acquires a Win32 Named Mutex to ensure only one host instance runs at a time."""

    def __init__(self, mutex_name: str = MUTEX_NAME) -> None:
        self.mutex_name = mutex_name
        self._mutex_handle: wintypes.HANDLE | None = None
        self.is_already_running = False

    def acquire(self) -> bool:
        """Attempt to acquire the mutex.

        Returns True if this process acquired the lock first.
        Returns False if another instance is already running.
        """
        try:
            kernel32 = ctypes.windll.kernel32
            kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
            kernel32.CreateMutexW.restype = wintypes.HANDLE

            handle = kernel32.CreateMutexW(None, True, self.mutex_name)
            last_error = kernel32.GetLastError()

            if last_error == ERROR_ALREADY_EXISTS or not handle:
                self.is_already_running = True
                logger.warning("Outra instância do PC Media Control já está em execução.")
                if handle:
                    kernel32.CloseHandle(handle)
                return False

            self._mutex_handle = handle
            self.is_already_running = False
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Falha ao criar Named Mutex (prosseguindo sem trava única): %s", exc)
            return True

    def release(self) -> None:
        """Release and close the Win32 Named Mutex."""
        if self._mutex_handle:
            try:
                kernel32 = ctypes.windll.kernel32
                kernel32.ReleaseMutex(self._mutex_handle)
                kernel32.CloseHandle(self._mutex_handle)
            except Exception as exc:  # noqa: BLE001
                logger.debug("Erro ao fechar handle do Mutex: %s", exc)
            finally:
                self._mutex_handle = None

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(self, exc_type: object, exc_val: object, exc_tb: object) -> None:
        self.release()

"""Script para compilar o executável autônomo do PC Media Control via PyInstaller."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def build() -> int:
    root_dir = Path(__file__).resolve().parent.parent
    os.chdir(root_dir)

    print("=" * 60)
    print("      PC Media Control — Compilação do Executável Windows      ")
    print("=" * 60)

    # 1. Build do cliente PWA caso client/dist não exista
    dist_html = root_dir / "client" / "dist" / "index.html"
    if not dist_html.is_file():
        print("\n[1/2] Build do frontend PWA não encontrado. Executando npm run build...")
        res = subprocess.run(["npm", "--prefix", "client", "run", "build"], check=False)
        if res.returncode != 0:
            print("[ERRO] Falha ao compilar o frontend client/")
            return res.returncode
    else:
        print("\n[1/2] Frontend PWA em client/dist verificado com sucesso.")

    # 2. Limpeza prévia do diretório build se existir
    build_dir = root_dir / "build"
    if build_dir.exists():
        import shutil
        import time

        for _ in range(3):
            try:
                shutil.rmtree(build_dir, ignore_errors=True)
                break
            except Exception:
                time.sleep(0.3)

    # 3. Execução do PyInstaller
    print("\n[2/2] Executando PyInstaller com pc_media_control.spec...")
    pyinstaller_bin = Path(sys.executable).parent / "pyinstaller.exe"
    cmd = [
        str(pyinstaller_bin) if pyinstaller_bin.is_file() else "pyinstaller",
        "--noconfirm",
        "pc_media_control.spec",
    ]
    res = subprocess.run(cmd, check=False)
    if res.returncode != 0:
        print("[ERRO] Falha na compilação do PyInstaller.")
        return res.returncode

    exe_path = root_dir / "dist" / "PCMediaControl.exe"
    if exe_path.is_file():
        size_mb = exe_path.stat().st_size / (1024 * 1024)
        print("\n" + "=" * 60)
        print(f"[SUCESSO] Executável gerado: {exe_path}")
        print(f"          Tamanho: {size_mb:.1f} MB")
        print("          Inicia em segundo plano com ícone na bandeja.")
        print("=" * 60 + "\n")
        return 0

    print("[ERRO] Executável não encontrado em dist/PCMediaControl.exe")
    return 1


if __name__ == "__main__":
    raise SystemExit(build())

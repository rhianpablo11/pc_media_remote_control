"""Testes de conformidade e integridade sintática de scripts PowerShell (.ps1)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

TYPOGRAPHIC_DANGERS = ["—", "–", "“", "”", "‘", "’", "«", "»"]


def get_repo_ps1_files() -> list[Path]:
    ps1_files: list[Path] = []
    for p in REPO_ROOT.rglob("*.ps1"):
        rel_parts = p.relative_to(REPO_ROOT).parts
        if any(part in {".venv", "node_modules", ".git"} for part in rel_parts):
            continue
        ps1_files.append(p)
    return ps1_files


def test_ps1_files_exist() -> None:
    files = get_repo_ps1_files()
    assert len(files) >= 1
    assert any(f.name == "allow_firewall.ps1" for f in files)


@pytest.mark.parametrize("ps1_file", get_repo_ps1_files(), ids=lambda p: str(p.name))
def test_ps1_encoding_has_bom_if_non_ascii(ps1_file: Path) -> None:
    raw = ps1_file.read_bytes()
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    non_ascii_bytes = [b for b in raw if b > 127]

    if non_ascii_bytes:
        assert has_bom, f"Arquivo {ps1_file.name} tem caracteres não-ASCII sem UTF-8 BOM!"

    content = raw.decode("utf-8-sig")
    for danger in TYPOGRAPHIC_DANGERS:
        assert danger not in content, (
            f"O arquivo {ps1_file} contém caractere tipográfico perigoso '{danger}'!"
        )


@pytest.mark.parametrize("ps1_file", get_repo_ps1_files(), ids=lambda p: str(p.name))
def test_ps1_syntax_validity_in_windows_powershell(ps1_file: Path) -> None:
    # Executa o Windows PowerShell 5.1 validando o parser AST do script
    ps_code = f"""
    $errors = $null
    $tokens = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        '{ps1_file.resolve()}',
        [ref]$tokens,
        [ref]$errors
    )
    if ($errors -and $errors.Count -gt 0) {{
        $errors | ForEach-Object {{ Write-Error $_.Message }}
        exit 1
    }}
    exit 0
    """
    res = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", ps_code],
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, f"Erros de sintaxe no PowerShell: {res.stderr}\n{res.stdout}"


def test_allow_firewall_execution_fails_only_due_to_elevation() -> None:
    script_path = REPO_ROOT / "scripts" / "allow_firewall.ps1"
    res = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path)],
        capture_output=True,
        text=True,
    )
    # Se o runner não for admin, falha com ScriptRequiresElevation (#Requires -RunAsAdministrator)
    # Se for admin, sai com 0. Em nenhum dos dois casos pode dar erro de sintaxe/parser!
    output = res.stderr + res.stdout
    assert "A cadeia de caracteres não tem o terminador" not in output
    assert "ParserError" not in output
    if res.returncode != 0:
        assert "ScriptRequiresElevation" in output or "PermissionDenied" in output

"""Corrige codificação de scripts .ps1 para UTF-8 com BOM e substitui tipografia."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

TYPOGRAPHIC_REPLACEMENTS = {
    "—": "-",  # em-dash
    "–": "-",  # en-dash
    "“": '"',  # left double quote
    "”": '"',  # right double quote
    "‘": "'",  # left single quote
    "’": "'",  # right single quote
    "«": '"',
    "»": '"',
}


def fix_ps1_file(path: Path) -> tuple[bool, str]:
    raw_bytes = path.read_bytes()

    try:
        content = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = raw_bytes.decode("cp1252")

    for char, rep in TYPOGRAPHIC_REPLACEMENTS.items():
        if char in content:
            content = content.replace(char, rep)

    # Check if non-ascii chars exist
    non_ascii = [c for c in content if ord(c) > 127]

    # Save as UTF-8 with BOM
    new_bytes = content.encode("utf-8-sig")
    if new_bytes != raw_bytes:
        path.write_bytes(new_bytes)
        return True, f"Atualizado com UTF-8-SIG (BOM). Caracteres não-ASCII: {len(non_ascii)}"

    return False, "Sem alterações necessárias."


def main() -> None:
    for p in REPO_ROOT.rglob("*.ps1"):
        if ".venv" in p.parts or "node_modules" in p.parts:
            continue
        changed, msg = fix_ps1_file(p)
        print(f"{p.relative_to(REPO_ROOT)}: {msg}")


if __name__ == "__main__":
    main()

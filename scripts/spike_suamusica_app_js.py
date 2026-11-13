import re
import urllib.request

url = "https://www.suamusica.com.br/_next/static/chunks/pages/_app-ef4c803fcc608b07.js"
req = urllib.request.Request(
    url,
    headers={
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
    },
)

with urllib.request.urlopen(req, timeout=10) as resp:
    code = resp.read().decode("utf-8", errors="ignore")

print(f"Code length: {len(code)}")
print("Has 'new Audio':", bool(re.search(r"new\s+Audio", code)))
print("Has 'createElement(\"audio\")':", bool(re.search(r"createElement\(['\"]audio['\"]\)", code)))
print("Has 'mediaSession':", bool(re.search(r"mediaSession", code)))
print("Has 'AudioContext':", bool(re.search(r"AudioContext", code)))
print("Has 'Hls':", bool(re.search(r"\bHls\b", code)))
print("Has 'howl':", bool(re.search(r"\bhowl\b", code, re.I)))

for m in re.finditer(r"new\s+Audio\b", code):
    start = max(0, m.start() - 50)
    end = min(len(code), m.end() + 150)
    print("Match new Audio context:", code[start:end])

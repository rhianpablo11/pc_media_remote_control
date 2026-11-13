import re
import urllib.request

url = "https://www.suamusica.com.br"
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
    html = resp.read().decode("utf-8", errors="ignore")

# Find player chunk or scripts
scripts = re.findall(r"""src=["']([^"']+)["']""", html)
print(f"Total scripts found: {len(scripts)}")

keywords = ["player", "hls", "audio", "app"]
player_related = [s for s in scripts if any(k in s.lower() for k in keywords)]
print("Player-related scripts:", player_related)

# Check OpenGraph tags
og_pattern = r"""<meta\s+property=["'](og:[^"']+)["']\s+content=["']([^"']*)["']"""
og_tags = re.findall(og_pattern, html, re.I)
print("OG tags in homepage:", og_tags)

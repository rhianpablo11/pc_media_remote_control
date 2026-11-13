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
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        html = resp.read().decode("utf-8", errors="ignore")
        print("HTTP status:", resp.status)
        print("HTML length:", len(html))
        print("Audio tags in initial HTML:", re.findall(r"<audio[^>]*>", html, re.I))
        print("Video tags in initial HTML:", re.findall(r"<video[^>]*>", html, re.I))
        iframes = re.findall(r"<iframe[^>]*>", html, re.I)
        print("Iframes count:", len(iframes))
        for ifr in iframes[:5]:
            print("  iframe:", ifr)
        scripts = re.findall(r"""<script[^>]*src=["']([^"']+)["']""", html, re.I)
        print("Script count:", len(scripts))
        for sc in scripts[:10]:
            print("  script:", sc)
except Exception as e:
    print("Error:", e)

"""Liveuamap scraper.

Historically this module used Playwright + Stealth to bypass anti-bot guards,
but Liveuamap actually serves the full marker dataset inline as a base64+
url-encoded JSON blob in the HTML response (`var ovens = '...';`). Using a
real browser was both expensive (~30s per region) and fragile — when the
container ships without a Playwright browser binary the scraper crashes
silently every cycle, leaving `latest_data["liveuamap"] = []`.

This rewrite uses plain HTTP via `requests`, which is:

- ~50x faster (no browser cold start)
- works in slim containers without Playwright/Chromium installed
- resilient against Turnstile JS challenges (the `ovens` blob is in the
  initial HTML response, before any anti-bot script runs)
"""

import base64
import json
import logging
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)


REGIONS = [
    {"name": "Ukraine", "url": "https://liveuamap.com"},
    {"name": "Middle East", "url": "https://mideast.liveuamap.com"},
    {"name": "Israel-Palestine", "url": "https://israelpalestine.liveuamap.com"},
    {"name": "Syria", "url": "https://syria.liveuamap.com"},
]

_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Match `var ovens = '...';` (single or double quoted)
_OVENS_RE = re.compile(r"var\s+ovens\s*=\s*['\"]([^'\"]+)['\"]\s*;")


def _http_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(
        total=2,
        backoff_factor=0.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    })
    return s


def _decode_ovens(encoded: str) -> Optional[Dict[str, Any]]:
    """Decode the `ovens` base64+url-encoded JSON blob."""
    try:
        b64 = urllib.parse.unquote(encoded)
        decoded = base64.b64decode(b64).decode("utf-8", errors="replace")
        return json.loads(decoded)
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as e:
        logger.warning(f"Liveuamap ovens decode failed: {e}")
        return None


def _format_timestamp(ts: Any) -> str:
    if not ts:
        return ""
    try:
        ts_int = int(ts)
        return datetime.fromtimestamp(ts_int, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    except (ValueError, TypeError, OSError):
        return str(ts)


def _normalize_marker(marker: Dict[str, Any], region: Dict[str, str], seen_ids: set) -> Optional[Dict[str, Any]]:
    mid = marker.get("id")
    if mid is None or mid in seen_ids:
        return None
    seen_ids.add(mid)

    title = (marker.get("name") or marker.get("s") or marker.get("title") or "Unknown Event").strip()
    description = (marker.get("description") or marker.get("udescription") or marker.get("d") or "").strip()
    image = marker.get("picture") or marker.get("img") or marker.get("twitpic") or ""
    source = (marker.get("source") or marker.get("src") or "").strip()
    raw_link = (marker.get("link") or marker.get("url") or "").strip()
    timestamp = marker.get("timestamp") or marker.get("time") or marker.get("t") or ""
    category = (marker.get("cat_id") or marker.get("c") or marker.get("category") or "").strip() if isinstance(
        marker.get("cat_id"), str
    ) else str(marker.get("cat_id", ""))

    link = raw_link
    if link and not link.startswith("http"):
        base = region["url"].rstrip("/")
        link = f"{base}/{link.lstrip('/')}"

    lat = marker.get("lat")
    lng = marker.get("lng")
    try:
        lat = float(lat) if lat not in (None, "") else None
        lng = float(lng) if lng not in (None, "") else None
    except (TypeError, ValueError):
        lat, lng = None, None

    return {
        "id": mid,
        "type": "liveuamap",
        "title": title,
        "description": description[:500],
        "lat": lat,
        "lng": lng,
        "timestamp": timestamp,
        "date": _format_timestamp(timestamp),
        "link": link or region["url"],
        "region": region["name"],
        "category": category,
        "image": image,
        "source": source,
    }


def fetch_liveuamap() -> List[Dict[str, Any]]:
    logger.info("Starting Liveuamap scraper (HTTP mode)...")
    session = _http_session()
    all_markers: List[Dict[str, Any]] = []
    seen_ids: set = set()
    region_stats: List[str] = []

    for region in REGIONS:
        try:
            resp = session.get(region["url"], timeout=15)
            if resp.status_code != 200:
                logger.warning(
                    f"Liveuamap {region['name']}: HTTP {resp.status_code} (skipped)"
                )
                continue
            html = resp.text
            m = _OVENS_RE.search(html)
            if not m:
                logger.warning(
                    f"Liveuamap {region['name']}: 'ovens' blob not found in HTML "
                    f"(size={len(html)})"
                )
                continue

            payload = _decode_ovens(m.group(1))
            if not payload:
                continue

            venues = payload.get("venues") if isinstance(payload, dict) else payload
            if not isinstance(venues, list):
                logger.warning(
                    f"Liveuamap {region['name']}: unexpected payload shape "
                    f"({type(venues).__name__})"
                )
                continue

            count = 0
            for marker in venues:
                if not isinstance(marker, dict):
                    continue
                normalized = _normalize_marker(marker, region, seen_ids)
                if normalized is not None:
                    all_markers.append(normalized)
                    count += 1
            region_stats.append(f"{region['name']}={count}")
        except requests.RequestException as e:
            logger.warning(f"Liveuamap {region['name']} fetch failed: {e}")
        except Exception as e:  # noqa: BLE001 — defensive: unexpected parser failure
            logger.error(f"Liveuamap {region['name']} unexpected error: {e}")

    logger.info(
        f"Liveuamap scraper finished: {len(all_markers)} unique markers "
        f"({', '.join(region_stats) if region_stats else 'no regions returned data'})"
    )
    return all_markers


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    res = fetch_liveuamap()
    print(json.dumps(res[:3], indent=2, default=str))

"""
Shopee Scraper — Windows Edition (Category / Keyword version)
Paste a Shopee category URL, a Shopee search URL, or a plain keyword —
scrapes 9 pages sorted by best-selling.
Fields: rank, name, link, stars, price, qty_sold
Uses Playwright CDP → user's real Chrome (handles all tokens automatically)
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox, filedialog
import threading
import json
import re
import os
import time
import urllib.parse

from playwright.sync_api import sync_playwright
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# ── constants ─────────────────────────────────────────────────────────────────
CHROME_CDP   = "http://localhost:9222"
SHEET_ID     = "1XGS24NGtbHiXKk2noescba6KBK4nxKU2Y5KMa6RxRTI"
CREDS_FILE   = "credentials.json"
MAX_PAGES    = 9
SHOPEE_BASE  = "https://shopee.co.th"
PROMO_PHRASES_FILE = "promo_phrases.txt"

HEADERS = ["Rank", "Keyword", "Name", "Link", "Stars", "Price (฿)", "Qty Sold / Month"]

# Fallback phrases used only if promo_phrases.txt is missing/empty.
DEFAULT_PROMO_PHRASES = [
    "แถม", "รับสินค้าฟรี", "ขายส่ง", "ส่งฟรี", "โค้ดส่วนลด", "คูปองส่วนลด",
    "คุ้มกว่าเดิม", "ลดสูงสุด", "ดีลเด็ด", "flash sale", "voucher",
]


def load_promo_phrases() -> list:
    """Literal substrings that mark a card's matched text as a promo badge
    rather than the product name (e.g. "ขายส่ง", "ส่งฟรี").

    These are read from promo_phrases.txt next to this script — one phrase
    per line, '#' for comments — so new badge wording Shopee introduces can
    be added without touching this file. Numeric "buy N get discount"
    badges (e.g. "ซื้อ 2 ชิ้น ลด ฿1") don't need an entry here; they're
    caught by the generic pattern in the scraper regardless of wording.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), PROMO_PHRASES_FILE)
    if not os.path.exists(path):
        return DEFAULT_PROMO_PHRASES
    phrases = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            phrases.append(line)
    return phrases or DEFAULT_PROMO_PHRASES


# ══════════════════════════════════════════════════════════════════════════════
#  INPUT HELPERS — category URL, search URL, or plain keyword
# ══════════════════════════════════════════════════════════════════════════════

CAT_ID_RE = re.compile(r"-cat\.([\d.]+)", re.IGNORECASE)

# Single-segment paths that are Shopee site sections, not shop usernames —
# guards shop-URL detection below from misfiring on things like a bare
# "https://shopee.co.th/search" (no ?keyword=) or "/cart".
RESERVED_SHOP_PATHS = {
    "search", "mall", "cart", "notifications", "help", "seller", "chat",
    "checkout", "user", "account", "payment", "voucher", "flash-sale",
    "daily-discover", "official-shop", "onboarding", "buyer", "shopeepay",
    "product-guarantee", "verify",
}


def parse_multi_input(raw_input: str) -> list:
    """Split a comma-separated input into individually-parsed dicts.

    Each comma-separated segment can be its own category URL, search URL,
    or plain keyword (they don't have to all be the same kind). Raises
    ValueError (naming the offending segment) if any segment is invalid,
    so bad input is caught before Chrome is even connected to.
    """
    segments = [s.strip() for s in (raw_input or "").split(",")]
    segments = [s for s in segments if s]
    if not segments:
        raise ValueError(
            "Input is empty. Paste a category URL, search URL, or keyword(s) "
            "separated by commas."
        )
    parsed = []
    for seg in segments:
        try:
            parsed.append(parse_input(seg))
        except ValueError as e:
            raise ValueError(f"'{seg}': {e}") from e
    return parsed


def parse_input(raw_input: str) -> dict:
    """Accept a Shopee category URL, a Shopee search URL, a shop URL, or a
    plain keyword.

    Returns dict with: mode ('category', 'keyword', or 'shop'), base
    (scheme+netloc+path), query (dict with sortBy applied as default), and
    label (category id, keyword, or shop username — used for the Sheets tab
    name / CSV filename).
    """
    raw = (raw_input or "").strip()
    if not raw:
        raise ValueError("Input is empty. Paste a category URL, search URL, shop URL, or keyword.")

    parsed = urllib.parse.urlparse(raw)
    is_url = bool(parsed.scheme) and bool(parsed.netloc)

    if is_url:
        if "shopee" not in parsed.netloc.lower():
            raise ValueError("Not a Shopee URL. Expected a shopee.co.th link.")
        query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

        m = CAT_ID_RE.search(parsed.path)
        if m:
            query.setdefault("sortBy", "sales")
            return {"mode": "category", "base": base, "query": query, "label": m.group(1)}

        keyword = query.get("keyword", "").strip()
        if keyword:
            query.setdefault("sortBy", "sales")
            return {"mode": "keyword", "base": base, "query": query, "label": keyword}

        # A shop's own storefront, e.g. shopee.co.th/s26_gold3?sortBy=sales&tab=0 —
        # a single path segment that isn't a category/search/reserved site section.
        segment = parsed.path.strip("/")
        if segment and "/" not in segment and segment.lower() not in RESERVED_SHOP_PATHS:
            query.setdefault("sortBy", "sales")
            return {"mode": "shop", "base": base, "query": query, "label": segment}

        raise ValueError(
            "URL is not a category page (missing '-cat.<id>'), a search page "
            "(missing '?keyword=...'), or a recognizable shop URL."
        )

    # Not a URL at all → treat the whole input as a search keyword.
    return {
        "mode": "keyword",
        "base": f"{SHOPEE_BASE}/search",
        "query": {"keyword": raw, "sortBy": "sales"},
        "label": raw,
    }


def build_page_url(parsed: dict, page: int) -> str:
    """Take the parsed input dict and produce the URL for `page` (0-indexed)."""
    q = dict(parsed["query"])
    q["page"] = str(page)
    return parsed["base"] + "?" + urllib.parse.urlencode(q, doseq=True)


# ══════════════════════════════════════════════════════════════════════════════
#  SCRAPER
# ══════════════════════════════════════════════════════════════════════════════

ITEM_SLUG_RE = re.compile(r"^(.*)-i\.\d+\.\d+$")
ITEM_ID_RE = re.compile(r"-i\.(\d+)\.(\d+)")


def item_key(link: str) -> str:
    """Canonical identity for a product: its shopid.itemid, parsed from the
    link. Two URLs for the same item can differ in tracking query params
    (extraParams, sp_atk, ...) or in which listing surface they came from
    (normal search vs. Shopee Mall search), so comparing raw link strings
    under-deduplicates. Falls back to the raw link if the URL doesn't match
    the expected item-URL shape.
    """
    if not link:
        return ""
    path = urllib.parse.urlparse(link).path
    m = ITEM_ID_RE.search(path)
    if m:
        return f"{m.group(1)}.{m.group(2)}"
    return link


def name_from_link(link: str) -> str:
    """Recover the product title from a Shopee item URL's SEO slug.

    Shopee builds item URLs as .../<slugified-title>-i.<shopid>.<itemid>,
    generating the slug straight from the real title — so it can never
    contain in-card promo-badge text the way scraped DOM text can. Special
    characters (%, /, &, ...) are stripped by Shopee's own slugifier and
    can't be recovered, so the result may be missing punctuation the
    on-page title has, but the words themselves are always the real name.

    Returns "" if the link doesn't match the expected item-URL shape (e.g.
    a non-standard or ad-redirect link), so callers can fall back to the
    DOM-scraped name.
    """
    if not link:
        return ""
    path = urllib.parse.urlparse(link).path.lstrip("/")
    decoded = urllib.parse.unquote(path, encoding="utf-8", errors="ignore")
    m = ITEM_SLUG_RE.match(decoded)
    if not m:
        return ""
    name = m.group(1).replace("-", " ")
    return re.sub(r"\s+", " ", name).strip()


def slugify_label(label: str) -> str:
    """Turn a category id or keyword (incl. Thai text) into a safe tab/file name."""
    safe = re.sub(r"[^\w.-]+", "_", (label or "").strip(), flags=re.UNICODE)
    return safe.strip("_") or "export"


QTY_MULTIPLIERS = {
    'พัน':   1_000,
    'หมื่น': 10_000,
    'แสน':   100_000,
    'ล้าน':  1_000_000,
    'K':     1_000,
    'k':     1_000,
    'M':     1_000_000,
    'm':     1_000_000,
}


def parse_qty_sold(raw: str):
    """Parse a raw sold-count string (Thai shorthand or plain number) into
    (number, has_plus_suffix). Returns (0.0, False) if unparseable/empty.
    """
    if not raw:
        return 0.0, False
    raw = raw.strip()
    for word, mult in QTY_MULTIPLIERS.items():
        m = re.search(r'([0-9]+(?:\.[0-9]+)?)\s*' + re.escape(word) + r'(\+?)', raw)
        if m:
            return float(m.group(1)) * mult, bool(m.group(2))
    m = re.search(r'([\d,]+(?:\.[\d]+)?)(\+?)', raw)
    if m:
        try:
            return float(m.group(1).replace(',', '')), bool(m.group(2))
        except ValueError:
            return 0.0, False
    return 0.0, False


def qty_sold_value(raw: str) -> float:
    """Numeric sold-count, for sorting — see parse_qty_sold()."""
    return parse_qty_sold(raw)[0]


def price_value(raw: str) -> float:
    """Numeric price, for sorting. Unknown/unparseable prices sort last."""
    if not raw:
        return float("inf")
    try:
        return float(str(raw).replace(",", ""))
    except ValueError:
        return float("inf")


def normalize_qty(raw: str) -> str:
    """Convert Thai sold-count shorthand to plain, comma-grouped numbers.
    e.g. '5พัน+' → '5,000+',  '1.2หมื่น+' → '12,000+',  '3แสน' → '300,000'
    """
    if not raw or not re.search(r'\d', raw):
        return raw
    num, has_plus = parse_qty_sold(raw)
    return f"{int(num):,}{'+' if has_plus else ''}"


# ── selectors Shopee has used across layouts ────────────────────────────────
CARD_SELECTORS = [
    "li[data-sqe='item']",
    "div[data-sqe='item']",
    ".shopee-search-item-result__item",
    "li.col-xs-2-4",
    "div[class*='grid'] li",
    "ul.row > li",
]


def _find_cards(pg):
    """Try every known card selector against an open page; return (selector, count)."""
    for sel in CARD_SELECTORS:
        try:
            count = pg.eval_on_selector_all(sel, "els => els.length")
            if count and count > 4:
                return sel, count
        except Exception:
            continue
    return None, 0


def _scrape_one_input(page, parsed: dict, log_fn, max_pages: int, promo_phrases_json: str) -> list:
    """Walk pages 0..max_pages-1 for a single already-parsed input (category,
    search URL, or keyword) using an already-open Playwright page. Returns a
    de-duped (within this input only — not across other inputs) list of raw
    item dicts, pre-rank and pre-name-resolution.
    """
    results = []

    for page_num in range(max_pages):
        url = build_page_url(parsed, page_num)
        log_fn(f"📄 Page {page_num + 1}/{max_pages} → {url}")

        page.goto(url, wait_until="networkidle", timeout=40000)
        time.sleep(2.5)   # let React hydrate

        # scroll to load all lazy images / cards
        for _ in range(8):
            page.mouse.wheel(0, 1000)
            time.sleep(0.35)
        time.sleep(1.5)

        card_sel, card_count = _find_cards(page)
        if not card_sel:
            snippet = page.evaluate("document.body.innerText.slice(0, 200)")
            log_fn(f"  ⚠️  No cards found on page {page_num + 1}.")
            log_fn(f"      Page text: {snippet[:150]}")
            if page_num == 0:
                log_fn("  💡 Tip: Make sure you're logged in to shopee.co.th in the debug Chrome window.")
            break

        log_fn(f"  🔎 Selector '{card_sel}' matched {card_count} cards")

        js_code = (
            "() => {\n"
            "  const results = [];\n"
            "  const items = document.querySelectorAll(" + repr(card_sel) + ");\n"
            "  items.forEach(item => {\n"
            "    const anchor = item.querySelector(\"a[href]\");\n"
            "    const rawHref = anchor ? anchor.getAttribute(\"href\") : \"\";\n"
            "    const link = rawHref ? (rawHref.startsWith(\"http\") ? rawHref : \"https://shopee.co.th\" + rawHref) : \"\";\n"
            "    const PROMO_PHRASES = " + promo_phrases_json + ";\n"
            "    const genericPromoRe = /(ซื้อ\\s*\\d+\\s*ชิ้น|ลด\\s*฿?\\s*\\d|ช้อป[^\\n]{0,15}คุ้ม|ยิ่งซื้อยิ่ง(คุ้ม|ได้)|flash\\s*sale|voucher)/i;\n"
            "    const isPromoText = t => genericPromoRe.test(t) || PROMO_PHRASES.some(p => t.toLowerCase().includes(p.toLowerCase()));\n"
            "    const nameSelectors = ['[data-sqe=\"name\"]', '[class*=\"item-name\"]', '[class*=\"itemName\"]', '[class*=\"ellipsis\"]', '[class*=\"name\"]'];\n"
            "    let name = \"\";\n"
            "    {\n"
            "      const seen = new Set();\n"
            "      let best = \"\";\n"
            "      for (const sel of nameSelectors) {\n"
            "        for (const el of item.querySelectorAll(sel)) {\n"
            "          const t = el.innerText.trim();\n"
            "          if (!t || seen.has(t)) continue;\n"
            "          seen.add(t);\n"
            "          if (!isPromoText(t) && t.length > best.length) best = t;\n"
            "        }\n"
            "      }\n"
            "      name = best;\n"
            "    }\n"
            "    if (!name && anchor) { name = anchor.innerText.trim().split(\"\\n\").map(l=>l.trim()).filter(l=>l.length>8 && !isPromoText(l))[0]||\"\" }\n"
            "    let stars = \"\";\n"
            "    for (const el of item.querySelectorAll(\"span,div\")) { const t=el.innerText.trim(); if(/^[1-5](\\.[0-9])?$/.test(t)){stars=t;break;} }\n"
            "    const fullText = item.innerText;\n"
            "    let price = \"\";\n"
            "    const pm = fullText.match(/\\u0e3f\\s?([\\d,]+(?:\\.[\\d]+)?)/);\n"
            "    if(pm){price=pm[1];}else{for(const el of item.querySelectorAll('[class*=\"price\"]')){const t=el.innerText.replace(/[^0-9,]/g,\"\");if(t){price=t;break;}}}\n"
            "    let qtySold = \"\";\n"
            "    const sm = fullText.match(/(ขายได้|ขายแล้ว)[^\\d]*(\\d[\\d,.]*[พันล้านหมื่นแสนKk]*\\+?)\\s*ชิ้น/);\n"
            "    if(sm){qtySold=sm[2].trim();}else{const em=fullText.match(/(\\d[\\d,.]*[KkMm]?)\\s*sold/i);if(em)qtySold=em[1];}\n"
            "    if(!qtySold){for(const el of item.querySelectorAll('[class*=\"sold\"]')){const t=el.innerText.trim();if(t&&/\\d/.test(t)){qtySold=t;break;}}}\n"
            "    const isMall=!!(item.querySelector('[class*=\"mall\"]')||item.querySelector('[class*=\"Mall\"]')||[...item.querySelectorAll(\"span,div\")].find(e=>e.innerText.trim()===\"Mall\"));\n"
            "    let discount=\"\";\n"
            "    const dm=fullText.match(/-(\\d{1,3})\\s*%/);\n"
            "    if(dm){discount=\"-\"+dm[1]+\"%\";}else{for(const el of item.querySelectorAll('[class*=\"discount\"],[class*=\"Discount\"]')){const t=el.innerText.trim();if(t&&t.includes(\"%\")){discount=t;break;}}}\n"
            "    let origPrice=\"\";\n"
            "    const ap=[...fullText.matchAll(/\\u0e3f\\s*([\\d,]+(?:\\.[\\d]+)?)/g)].map(m=>m[1]);\n"
            "    if(ap.length>=2){const curr=price.replace(/,/g,\"\");for(const p of ap){if(p.replace(/,/g,\"\")!==curr){origPrice=p;break;}}}\n"
            "    if(!origPrice){for(const el of item.querySelectorAll('[class*=\"line-through\"],[class*=\"before\"],[class*=\"original\"],[class*=\"del\"]')){const t=el.innerText.replace(/[^0-9,]/g,\"\");if(t){origPrice=t;break;}}}\n"
            "    let shipping=\"\";\n"
            "    const skws=[\"ส่งฟรี\",\"ฟรีค่าจัดส่ง\",\"freeship\",\"จัดส่งฟรี\"];\n"
            "    const lt=fullText.toLowerCase();for(const kw of skws){if(lt.includes(kw.toLowerCase())){shipping=kw;break;}}\n"
            "    if(!shipping){for(const el of item.querySelectorAll('[class*=\"ship\"],[class*=\"Ship\"],[class*=\"delivery\"],[class*=\"free\"]')){const t=el.innerText.trim();if(t&&t.length<30){shipping=t;break;}}}\n"
            "    let location=\"\";\n"
            "    for(const el of item.querySelectorAll('[class*=\"location\"],[class*=\"Location\"],[class*=\"province\"],[class*=\"region\"]')){const t=el.innerText.trim();if(t&&t.length<60){location=t;break;}}\n"
            "    if(!location){const lm=fullText.match(/จังหวัด([^\\n]+)/);if(lm)location=\"จังหวัด\"+lm[1].trim().slice(0,30);}\n"
            "    const isSponsored=!!(item.querySelector('[class*=\"ads\"],[class*=\"sponsor\"],[class*=\"Ads\"],[class*=\"promoted\"]')||fullText.includes(\"Sponsored\")||fullText.includes(\"โฆษณา\"));\n"
            "    if(link)results.push({name,link,stars,price,origPrice,discount,qtySold,isMall,shipping,location,isSponsored});\n"
            "  });\n"
            "  return results;\n"
            "}"
        )
        cards = page.evaluate(js_code)

        page_count_before = len(results)
        seen_links = {r['link'] for r in results}
        for item in cards:
            if item['link'] and item['link'] not in seen_links:
                results.append(item)
                seen_links.add(item['link'])

        added = len(results) - page_count_before
        dupes = len(cards) - added
        log_fn(f"  ✅ Collected {added} new items (skipped {dupes} dupes, total: {len(results)})")

        if added == 0:
            log_fn("  ⚠️  No new items, stopping early.")
            break

    return results


def _dedupe_by_item(raw_results: list) -> list:
    """Drop duplicate products (same shopid.itemid) from a combined result
    set, keeping the first occurrence — see item_key()."""
    seen = set()
    out = []
    for r in raw_results:
        key = item_key(r.get("link", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _rank_group(raw_results: list, label: str) -> list:
    """Dedupe a group of raw results (all belonging to the same keyword or
    category), rank them by quantity sold (highest first, price ascending
    as the tiebreaker), and shape them into output rows starting at rank 1.
    """
    deduped = _dedupe_by_item(raw_results)
    deduped.sort(key=lambda r: (
        -qty_sold_value(r.get("qtySold", "")),
        price_value(r.get("price", "")),
    ))

    ranked = []
    for i, r in enumerate(deduped, 1):
        link = r.get("link", "")
        name = name_from_link(link) or r.get("name", "")
        ranked.append({
            "rank":       i,
            "keyword":    label,
            "name":       name,
            "link":       link,
            "stars":      r.get("stars", ""),
            "price":      r.get("price", ""),
            "qty_sold":   normalize_qty(r.get("qtySold", "")),
        })
    return ranked


def scrape_shopee_multi(raw_input: str, log_fn, max_pages: int = MAX_PAGES):
    """
    Accepts one or more comma-separated inputs — each a category URL, search
    URL, or plain keyword. Connects to Chrome once and runs every input
    sequentially over that same connection.

    For keyword inputs, both shopee.co.th/search and shopee.co.th/mall/search
    are scraped and merged — the two surfaces return noticeably different
    (and each individually incomplete-looking) result sets for the same
    keyword, so combining them gives better coverage. Duplicates (the same
    product appearing in both) are dropped by canonical item id, not by
    matching the raw link, since tracking query params differ between the
    two surfaces.

    Every output row is tagged with the input ("keyword" column) that
    produced it. Rank is (re)computed within each input's own result set —
    not taken from page order — as quantity sold descending, with price
    ascending as the tiebreaker, and restarts at 1 for every input, so
    results from different keywords don't get mixed together or deduped
    against each other.
    """
    parsed_list = parse_multi_input(raw_input)
    promo_phrases_json = json.dumps(load_promo_phrases(), ensure_ascii=False)

    all_ranked = []

    with sync_playwright() as p:
        log_fn("🔌 Connecting to Chrome...")
        try:
            browser = p.chromium.connect_over_cdp(CHROME_CDP)
        except Exception as e:
            raise ConnectionError(
                f"Cannot connect to Chrome at {CHROME_CDP}.\n"
                "Make sure Chrome is running with:\n"
                r'  chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome_debug'
            ) from e

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page    = context.new_page()

        total = len(parsed_list)
        for idx, parsed in enumerate(parsed_list, 1):
            label = parsed["label"]

            if parsed["mode"] == "keyword":
                log_fn(f"🔍 Keyword [{idx}/{total}]: {label}")
                log_fn("  🔎 Searching shopee.co.th/search…")
                normal_input = {"mode": "keyword", "base": f"{SHOPEE_BASE}/search",
                                 "query": parsed["query"], "label": label}
                raw_results = _scrape_one_input(page, normal_input, log_fn, max_pages, promo_phrases_json)

                log_fn("  🏬 Searching shopee.co.th/mall/search…")
                mall_input = {"mode": "keyword", "base": f"{SHOPEE_BASE}/mall/search",
                              "query": parsed["query"], "label": label}
                raw_results += _scrape_one_input(page, mall_input, log_fn, max_pages, promo_phrases_json)
            elif parsed["mode"] == "shop":
                log_fn(f"🏪 Shop [{idx}/{total}]: {label}")
                raw_results = _scrape_one_input(page, parsed, log_fn, max_pages, promo_phrases_json)
            else:
                log_fn(f"🏷  Category ID [{idx}/{total}]: {label}")
                raw_results = _scrape_one_input(page, parsed, log_fn, max_pages, promo_phrases_json)

            all_ranked.extend(_rank_group(raw_results, label))

        page.close()
        browser.close()

    return all_ranked


# ══════════════════════════════════════════════════════════════════════════════
#  GOOGLE SHEETS
# ══════════════════════════════════════════════════════════════════════════════

def push_to_sheets(data: list, sheet_id: str, label: str, creds_file: str, log_fn):
    log_fn("📊 Connecting to Google Sheets...")
    creds  = Credentials.from_service_account_file(
        creds_file,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    svc    = build("sheets", "v4", credentials=creds)
    sheets = svc.spreadsheets()

    # Create a new tab named after the label + timestamp
    import datetime
    safe_label = slugify_label(label)[:25]
    tab_name = f"{safe_label}_{datetime.datetime.now().strftime('%m%d_%H%M')}"

    body = {"requests": [{"addSheet": {"properties": {"title": tab_name}}}]}
    sheets.batchUpdate(spreadsheetId=sheet_id, body=body).execute()
    log_fn(f"  📋 Created tab: {tab_name}")

    # write header + data
    rows = [HEADERS]
    for r in data:
        rows.append([
            r["rank"], r["keyword"], r["name"], r["link"],
            r["stars"], r["price"], r["qty_sold"],
        ])

    sheets.values().update(
        spreadsheetId=sheet_id,
        range=f"'{tab_name}'!A1",
        valueInputOption="RAW",
        body={"values": rows},
    ).execute()
    log_fn(f"  ✅ Wrote {len(data)} rows to Sheets.")


def export_csv(data: list, filepath: str):
    import csv
    with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["rank","keyword","name","link","stars","price","qty_sold"])
        writer.writeheader()
        writer.writerows(data)


# ══════════════════════════════════════════════════════════════════════════════
#  GUI
# ══════════════════════════════════════════════════════════════════════════════

class ShopeeCategoryScraperApp(tk.Tk):

    SHOPEE_ORANGE = "#EE4D2D"
    BG            = "#1A1A2E"
    PANEL         = "#16213E"
    ACCENT        = "#E94560"
    TEXT          = "#EAEAEA"
    MUTED         = "#8892A4"
    SUCCESS       = "#2ECC71"
    WARNING       = "#F39C12"

    def __init__(self):
        super().__init__()
        self.title("Shopee Scraper — Category / Keyword")
        self.geometry("1100x780")
        self.configure(bg=self.BG)
        self.resizable(True, True)

        self._results   = []
        self._scraping  = False
        self._label     = ""
        self._mode      = ""

        self._build_ui()

    # ── UI BUILD ──────────────────────────────────────────────────────────────

    def _build_ui(self):
        # ── header bar ────────────────────────────────────────────────────────
        header = tk.Frame(self, bg=self.SHOPEE_ORANGE, height=56)
        header.pack(fill="x")
        header.pack_propagate(False)

        tk.Label(
            header, text="🛒  Shopee Scraper",
            bg=self.SHOPEE_ORANGE, fg="white",
            font=("Segoe UI", 16, "bold"),
        ).pack(side="left", padx=20, pady=12)

        tk.Label(
            header, text="หมวดหมู่ / คีย์เวิร์ด / ร้านค้า (category, keyword, or shop) · 9 หน้า",
            bg=self.SHOPEE_ORANGE, fg="#FFE0D8",
            font=("Segoe UI", 10),
        ).pack(side="left", padx=6)

        # ── main body split ───────────────────────────────────────────────────
        body = tk.Frame(self, bg=self.BG)
        body.pack(fill="both", expand=True, padx=16, pady=12)

        left  = tk.Frame(body, bg=self.BG, width=340)
        left.pack(side="left", fill="y", padx=(0, 12))
        left.pack_propagate(False)

        right = tk.Frame(body, bg=self.BG)
        right.pack(side="left", fill="both", expand=True)

        self._build_left(left)
        self._build_right(right)

    def _build_left(self, parent):
        # ── search card ───────────────────────────────────────────────────────
        card = tk.Frame(parent, bg=self.PANEL, bd=0)
        card.pack(fill="x", pady=(0, 12))

        self._section_label(card, "🔗  Category / Keyword / Shop URL")

        tk.Label(card, text="Paste category URL, search URL, shop URL, or keyword(s)", bg=self.PANEL, fg=self.MUTED,
                 font=("Segoe UI", 9)).pack(anchor="w", padx=16, pady=(6, 2))

        self.url_var = tk.StringVar()
        url_entry = tk.Entry(
            card, textvariable=self.url_var,
            bg="#0F3460", fg=self.TEXT, insertbackground=self.TEXT,
            font=("Segoe UI", 9), relief="flat", bd=8,
        )
        url_entry.pack(fill="x", padx=16, pady=(0, 4))
        url_entry.bind("<Return>", lambda e: self._start_scrape())

        tk.Label(
            card,
            text=(
                "e.g. https://shopee.co.th/...-cat.11044959.11045208?sortBy=sales\n"
                "or https://shopee.co.th/search?keyword=นมผง\n"
                "or a shop's own page: https://shopee.co.th/s26_gold3\n"
                "or just: นมผง\n"
                "Multiple inputs, comma-separated: นมผง, ยาสีฟัน, https://shopee.co.th/s26_gold3\n"
                "(each input gets its own rank 1..N, tagged in the Keyword column)"
            ),
            bg=self.PANEL, fg=self.MUTED,
            font=("Segoe UI", 8), wraplength=290, justify="left",
        ).pack(anchor="w", padx=16, pady=(0, 8))

        tk.Label(card, text="Pages (1–9)", bg=self.PANEL, fg=self.MUTED,
                 font=("Segoe UI", 9)).pack(anchor="w", padx=16, pady=(8, 2))

        self.pages_var = tk.IntVar(value=MAX_PAGES)
        pages_spin = tk.Spinbox(
            card, from_=1, to=MAX_PAGES, textvariable=self.pages_var, width=6,
            bg="#0F3460", fg=self.TEXT, buttonbackground="#0F3460",
            font=("Segoe UI", 11), relief="flat",
        )
        pages_spin.pack(anchor="w", padx=16, pady=(0, 12))

        self.scrape_btn = tk.Button(
            card, text="▶  Start Scraping",
            bg=self.SHOPEE_ORANGE, fg="white",
            font=("Segoe UI", 11, "bold"),
            relief="flat", cursor="hand2", padx=10, pady=8,
            command=self._start_scrape,
        )
        self.scrape_btn.pack(fill="x", padx=16, pady=(0, 16))

        # ── output card ───────────────────────────────────────────────────────
        card2 = tk.Frame(parent, bg=self.PANEL, bd=0)
        card2.pack(fill="x", pady=(0, 12))

        self._section_label(card2, "📤  Export")

        tk.Label(card2, text="Google Sheet ID", bg=self.PANEL, fg=self.MUTED,
                 font=("Segoe UI", 9)).pack(anchor="w", padx=16, pady=(6, 2))

        self.sheet_var = tk.StringVar(value=SHEET_ID)
        tk.Entry(
            card2, textvariable=self.sheet_var,
            bg="#0F3460", fg=self.TEXT, insertbackground=self.TEXT,
            font=("Segoe UI", 9), relief="flat", bd=6,
        ).pack(fill="x", padx=16, pady=(0, 8))

        tk.Label(card2, text="Credentials JSON", bg=self.PANEL, fg=self.MUTED,
                 font=("Segoe UI", 9)).pack(anchor="w", padx=16)
        creds_row = tk.Frame(card2, bg=self.PANEL)
        creds_row.pack(fill="x", padx=16, pady=(2, 8))

        self.creds_var = tk.StringVar(value=CREDS_FILE)
        tk.Entry(
            creds_row, textvariable=self.creds_var,
            bg="#0F3460", fg=self.TEXT, insertbackground=self.TEXT,
            font=("Segoe UI", 9), relief="flat", bd=6,
        ).pack(side="left", fill="x", expand=True)
        tk.Button(
            creds_row, text="…",
            bg="#0F3460", fg=self.TEXT, relief="flat", cursor="hand2",
            command=self._pick_creds,
        ).pack(side="left", padx=(4, 0))

        self.sheets_btn = tk.Button(
            card2, text="📊  Push to Google Sheets",
            bg="#1DB954", fg="white",
            font=("Segoe UI", 10, "bold"),
            relief="flat", cursor="hand2", padx=10, pady=7,
            command=self._push_sheets, state="disabled",
        )
        self.sheets_btn.pack(fill="x", padx=16, pady=(0, 8))

        self.csv_btn = tk.Button(
            card2, text="💾  Export CSV",
            bg="#0F3460", fg=self.TEXT,
            font=("Segoe UI", 10),
            relief="flat", cursor="hand2", padx=10, pady=7,
            command=self._export_csv, state="disabled",
        )
        self.csv_btn.pack(fill="x", padx=16, pady=(0, 16))

        # ── chrome setup card ─────────────────────────────────────────────────
        card3 = tk.Frame(parent, bg=self.PANEL, bd=0)
        card3.pack(fill="x")

        self._section_label(card3, "📡  Chrome Setup")

        # big launch button
        self.chrome_btn = tk.Button(
            card3, text="🚀  Launch Chrome Debug",
            bg=self.SHOPEE_ORANGE, fg="white",
            font=("Segoe UI", 11, "bold"),
            relief="flat", cursor="hand2", padx=10, pady=9,
            command=self._launch_chrome,
        )
        self.chrome_btn.pack(fill="x", padx=16, pady=(6, 6))

        # chrome status indicator
        self.chrome_status_lbl = tk.Label(
            card3, text="● Chrome not detected",
            bg=self.PANEL, fg="#E74C3C",
            font=("Segoe UI", 8),
        )
        self.chrome_status_lbl.pack(anchor="w", padx=18, pady=(0, 6))

        # command display + copy button
        CHROME_CMD = (
            r'"C:\Program Files\Google\Chrome\Application\chrome.exe"'
            " --remote-debugging-port=9222"
            r" --user-data-dir=C:\chrome_debug"
        )
        self._chrome_cmd = CHROME_CMD
        cmd_frame = tk.Frame(card3, bg="#0A0A1A", bd=0)
        cmd_frame.pack(fill="x", padx=16, pady=(0, 4))

        tk.Label(
            cmd_frame,
            text=CHROME_CMD,
            bg="#0A0A1A", fg="#6EE7B7",
            font=("Courier New", 7), justify="left",
            wraplength=260, anchor="w",
        ).pack(side="left", fill="x", expand=True, padx=6, pady=6)

        tk.Button(
            cmd_frame, text="⎘ Copy",
            bg="#0F3460", fg=self.TEXT,
            font=("Segoe UI", 8), relief="flat", cursor="hand2",
            padx=6,
            command=lambda: self._copy_to_clipboard(CHROME_CMD),
        ).pack(side="right", padx=4, pady=4)

        tk.Label(
            card3,
            text="After Chrome opens → log in to shopee.co.th",
            bg=self.PANEL, fg=self.MUTED,
            font=("Segoe UI", 8), wraplength=290, justify="left",
        ).pack(anchor="w", padx=16, pady=(2, 12))

        # start polling Chrome CDP status
        self._poll_chrome_status()

    def _build_right(self, parent):
        # ── progress bar ──────────────────────────────────────────────────────
        prog_frame = tk.Frame(parent, bg=self.BG)
        prog_frame.pack(fill="x", pady=(0, 8))

        self.progress_var = tk.DoubleVar(value=0)
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(
            "Orange.Horizontal.TProgressbar",
            troughcolor=self.PANEL,
            background=self.SHOPEE_ORANGE,
            bordercolor=self.BG,
            lightcolor=self.SHOPEE_ORANGE,
            darkcolor=self.SHOPEE_ORANGE,
        )
        self.pbar = ttk.Progressbar(
            prog_frame, variable=self.progress_var,
            style="Orange.Horizontal.TProgressbar",
            maximum=100, length=200,
        )
        self.pbar.pack(fill="x", side="left", expand=True)

        self.status_label = tk.Label(
            prog_frame, text="Idle", bg=self.BG, fg=self.MUTED,
            font=("Segoe UI", 9),
        )
        self.status_label.pack(side="left", padx=(10, 0))

        # ── results table ─────────────────────────────────────────────────────
        table_frame = tk.Frame(parent, bg=self.BG)
        table_frame.pack(fill="both", expand=True)

        cols = ("rank", "keyword", "name", "stars", "price", "qty_sold")
        col_widths = {"rank": 45, "keyword": 110, "name": 330, "stars": 55, "price": 90, "qty_sold": 130}
        col_labels = {"rank": "#", "keyword": "Keyword", "name": "Product Name", "stars": "⭐", "price": "Price ฿", "qty_sold": "Sold / Month"}

        style.configure("Shopee.Treeview",
            background=self.PANEL,
            foreground=self.TEXT,
            rowheight=28,
            fieldbackground=self.PANEL,
            bordercolor=self.BG,
            font=("Segoe UI", 9),
        )
        style.configure("Shopee.Treeview.Heading",
            background="#0F3460",
            foreground=self.TEXT,
            relief="flat",
            font=("Segoe UI", 9, "bold"),
        )
        style.map("Shopee.Treeview",
            background=[("selected", self.SHOPEE_ORANGE)],
        )

        self.tree = ttk.Treeview(
            table_frame, columns=cols, show="headings",
            style="Shopee.Treeview", selectmode="browse",
        )
        for c in cols:
            self.tree.heading(c, text=col_labels[c])
            self.tree.column(c, width=col_widths[c], minwidth=40, anchor="w")

        vsb = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self.tree.pack(fill="both", expand=True)

        # alternating row colours
        self.tree.tag_configure("odd",  background="#1A1A35")
        self.tree.tag_configure("even", background=self.PANEL)

        # double-click → open link
        self.tree.bind("<Double-1>", self._open_link)

        # ── log area ──────────────────────────────────────────────────────────
        log_frame = tk.Frame(parent, bg=self.BG)
        log_frame.pack(fill="x", pady=(8, 0))

        tk.Label(log_frame, text="Log", bg=self.BG, fg=self.MUTED,
                 font=("Segoe UI", 8, "bold")).pack(anchor="w")

        self.log_box = scrolledtext.ScrolledText(
            log_frame, height=7, bg="#0A0A1A", fg="#6EE7B7",
            font=("Courier New", 8), relief="flat",
            state="disabled",
        )
        self.log_box.pack(fill="x")

    # ── helpers ───────────────────────────────────────────────────────────────

    def _section_label(self, parent, text):
        row = tk.Frame(parent, bg=self.SHOPEE_ORANGE, height=2)
        row.pack(fill="x")
        tk.Label(
            parent, text=text,
            bg=self.PANEL, fg=self.TEXT,
            font=("Segoe UI", 10, "bold"),
        ).pack(anchor="w", padx=16, pady=(10, 4))

    def _log(self, msg: str):
        self.log_box.configure(state="normal")
        self.log_box.insert("end", msg + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")
        self.update_idletasks()

    def _set_status(self, msg: str, color=None):
        self.status_label.configure(text=msg, fg=color or self.MUTED)

    def _pick_creds(self):
        path = filedialog.askopenfilename(
            title="Select credentials.json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")],
        )
        if path:
            self.creds_var.set(path)

    def _copy_to_clipboard(self, text: str):
        self.clipboard_clear()
        self.clipboard_append(text)
        self.update()
        try:
            orig = self.chrome_status_lbl.cget("text")
            self.chrome_status_lbl.configure(text="✅ Copied to clipboard!", fg="#2ECC71")
            self.after(1800, lambda: self.chrome_status_lbl.configure(text=orig,
                fg="#2ECC71" if "detected" in orig or "running" in orig.lower() else "#E74C3C"))
        except Exception:
            pass

    def _launch_chrome(self):
        """Find Chrome and launch it with CDP flags, no external .bat needed."""
        import subprocess, shutil

        chrome_paths = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ]
        chrome_exe = next((p for p in chrome_paths if os.path.exists(p)), None)

        if not chrome_exe:
            chrome_exe = shutil.which("chrome") or shutil.which("chrome.exe")

        if not chrome_exe:
            messagebox.showerror(
                "Chrome Not Found",
                "Could not find Chrome.\n\n"
                "Please copy the command below and run it manually in CMD.",
            )
            return

        cmd = [
            chrome_exe,
            "--remote-debugging-port=9222",
            r"--user-data-dir=C:\chrome_debug",
        ]
        try:
            subprocess.Popen(cmd)
            self._log(f"🚀 Chrome launched: {chrome_exe}")
            self._log("   Log in to shopee.co.th, then click Start Scraping.")
            self.after(2000, self._poll_chrome_status)
        except Exception as e:
            messagebox.showerror("Launch Failed", str(e))

    def _poll_chrome_status(self):
        """Ping CDP every 3 s and update the status dot."""
        import urllib.request
        def check():
            try:
                urllib.request.urlopen("http://localhost:9222/json/version", timeout=1)
                return True
            except Exception:
                return False

        def update():
            alive = check()
            if alive:
                self.chrome_status_lbl.configure(
                    text="● Chrome debug running ✓", fg="#2ECC71"
                )
            else:
                self.chrome_status_lbl.configure(
                    text="● Chrome not detected", fg="#E74C3C"
                )
            self.after(3000, update)

        update()

    def _open_link(self, event):
        item = self.tree.focus()
        if not item:
            return
        # Use the row's position in the tree, not the displayed rank number —
        # rank restarts at 1 for every keyword, so it's not a unique index
        # into self._results once more than one keyword has been scraped.
        idx = self.tree.index(item)
        if not (0 <= idx < len(self._results)):
            return
        link = self._results[idx]["link"]
        if link:
            import webbrowser
            webbrowser.open(link)

    # ── actions ───────────────────────────────────────────────────────────────

    def _start_scrape(self):
        if self._scraping:
            return
        raw_input = self.url_var.get().strip()
        if not raw_input:
            messagebox.showwarning("No input", "Please paste a category URL, search URL, or keyword(s).")
            return
        try:
            parsed_list = parse_multi_input(raw_input)
        except ValueError as e:
            messagebox.showerror("Invalid Input", str(e))
            return

        if len(parsed_list) == 1:
            self._label = parsed_list[0]["label"]
            self._mode  = parsed_list[0]["mode"]
        else:
            self._label = f"{parsed_list[0]['label']}_+{len(parsed_list) - 1}more"
            self._mode  = "keyword"

        self._scraping = True
        self.scrape_btn.configure(state="disabled", text="⏳  Scraping...")
        self.sheets_btn.configure(state="disabled")
        self.csv_btn.configure(state="disabled")
        self._results = []
        self.progress_var.set(0)

        for row in self.tree.get_children():
            self.tree.delete(row)

        pages = self.pages_var.get()
        threading.Thread(
            target=self._scrape_thread, args=(raw_input, pages), daemon=True
        ).start()

    def _scrape_thread(self, raw_input: str, pages: int):
        try:
            def log_fn(msg):
                self.after(0, self._log, msg)
                m = re.search(r"Page (\d+)/(\d+)", msg)
                if m:
                    pct = int(m.group(1)) / int(m.group(2)) * 100
                    self.after(0, self.progress_var.set, pct)

            self.after(0, self._set_status, f"Scraping '{self._label}'…", self.WARNING)
            data = scrape_shopee_multi(raw_input, log_fn, max_pages=pages)
            self._results = data
            self.after(0, self._populate_table, data)
            self.after(0, self._set_status, f"Done — {len(data)} products", self.SUCCESS)
            self.after(0, self.progress_var.set, 100)
            self.after(0, self._log, f"\n✅ Scraped {len(data)} products.\nDouble-click a row to open in browser.")

        except ConnectionError as e:
            self.after(0, messagebox.showerror, "Connection Error", str(e))
            self.after(0, self._set_status, "Connection failed", self.ACCENT)
        except Exception as e:
            self.after(0, messagebox.showerror, "Error", str(e))
            self.after(0, self._set_status, "Error", self.ACCENT)
        finally:
            self._scraping = False
            self.after(0, self.scrape_btn.configure, {"state": "normal", "text": "▶  Start Scraping"})
            if self._results:
                self.after(0, self.sheets_btn.configure, {"state": "normal"})
                self.after(0, self.csv_btn.configure, {"state": "normal"})

    def _populate_table(self, data: list):
        for row in self.tree.get_children():
            self.tree.delete(row)
        for i, r in enumerate(data):
            tag = "odd" if i % 2 == 0 else "even"
            self.tree.insert("", "end", values=(
                r["rank"], r["keyword"], r["name"], r["stars"], r["price"],
                r["qty_sold"],
            ), tags=(tag,))

    def _push_sheets(self):
        if not self._results:
            messagebox.showinfo("No data", "Scrape first.")
            return
        creds = self.creds_var.get().strip()
        if not os.path.exists(creds):
            messagebox.showerror("Missing credentials", f"File not found:\n{creds}")
            return

        self.sheets_btn.configure(state="disabled", text="⏳  Pushing…")

        def do_push():
            try:
                push_to_sheets(
                    self._results,
                    self.sheet_var.get().strip(),
                    self._label or "export",
                    creds,
                    lambda m: self.after(0, self._log, m),
                )
                self.after(0, messagebox.showinfo, "Done", "Data pushed to Google Sheets ✅")
            except Exception as e:
                self.after(0, messagebox.showerror, "Sheets Error", str(e))
            finally:
                self.after(0, self.sheets_btn.configure, {"state": "normal", "text": "📊  Push to Google Sheets"})

        threading.Thread(target=do_push, daemon=True).start()

    def _export_csv(self):
        if not self._results:
            messagebox.showinfo("No data", "Scrape first.")
            return
        label = slugify_label(self._label or "export")
        prefix = {"category": "cat", "shop": "shop"}.get(self._mode, "kw")
        path = filedialog.asksaveasfilename(
            defaultextension=".csv",
            initialfile=f"shopee_{prefix}_{label}.csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        if path:
            try:
                export_csv(self._results, path)
                messagebox.showinfo("Saved", f"CSV saved:\n{path}")
            except Exception as e:
                messagebox.showerror("Export Error", str(e))


# ══════════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = ShopeeCategoryScraperApp()
    app.mainloop()

#!/usr/bin/env python3
"""
Build (or rebuild) products.sqlite from Shopee/iHerb affiliate datafeed CSVs.

This is the retail-product equivalent of build-agoda-db.py: a slim, indexed,
merchant-agnostic SQLite DB (+ an FTS5 keyword index) that the running bot
queries locally (product-db.ts / product-search.ts) — the bot never touches
the raw CSVs, only this file.

Usage:
    python3 scripts/build-products-db.py \
        --shopee SG:/path/to/shopee_sg.csv \
        --shopee MY:/path/to/shopee_my.csv \
        --iherb  SG:/path/to/iherb_sg.csv \
        --out products.sqlite

Each --shopee/--iherb flag takes COUNTRY:PATH — pass one per feed you have.
Re-running rebuilds the whole DB from scratch (DROP + recreate), matching how
the feeds themselves are full snapshots, not incremental diffs.

Column mapping notes:
- Shopee feeds are comma-delimited CSV with quoted fields (real RFC4180 —
  descriptions contain embedded commas/quotes). Column ORDER differs between
  countries (confirmed: SG vs MY have different orderings and MY/TH have a
  few extra columns SG doesn't) — always read by header name via
  csv.DictReader, never by position.
- Shopee's `product_link` column is already the clean canonical URL
  (https://shopee.<tld>/product/<shopid>/<itemid>) — no tracking wrapper to
  strip, stored as-is into product_url.
- iHerb feeds are PIPE-delimited (url|title|price|image|productID|
  description|category|categoryLink|inventory|promotionText|upc). Its `url`
  column is wrapped in an Involve Asia / Partnerize tracking redirect
  (https://iherb.prf.hn/click/camref:.../destination:<url-encoded url>) —
  this MUST be unwrapped back to the raw destination URL before storing,
  since we mint our own wallet-attributed tracking link fresh at booking
  time (see ACPLagunaTranslator's mint-affiliate-link.ts), not reuse
  Involve Asia's baked-in camref/creativeref.
"""
import argparse
import csv
import re
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs

DESCRIPTION_MAX_CHARS = 500
BATCH = 20000


def to_float(v):
    if v is None:
        return None
    v = str(v).strip()
    if v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def to_int(v):
    f = to_float(v)
    return int(f) if f is not None else None


def to_bool_int(v):
    """Shopee's is_official_shop/is_preferred_shop are strings like 'Official shop' /
    'Non-Preferred seller' / 'Yes' / 'No' — truthy iff it doesn't start with 'Non-' and
    isn't 'No'."""
    if v is None:
        return 0
    v = str(v).strip().lower()
    if v in ("", "no", "none"):
        return 0
    if v.startswith("non-"):
        return 0
    return 1


def truncate(s, n=DESCRIPTION_MAX_CHARS):
    if not s:
        return s
    return s[:n]


def strip_nuls(fileobj):
    # Same issue seen in Agoda_Hotels_EN.csv (build-agoda-db.py): a handful of rows in
    # the wild MY feed contain embedded NUL bytes, which trips up Python's csv module
    # ("line contains NUL"). Strip them.
    for line in fileobj:
        if "\x00" in line:
            line = line.replace("\x00", "")
        yield line


# ---------------------------------------------------------------------------
# iHerb: unwrap the prf.hn tracking link down to the raw destination URL
# ---------------------------------------------------------------------------

def unwrap_iherb_url(wrapped_url):
    """https://iherb.prf.hn/click/camref:.../creativeref:.../destination:<url-encoded>
    -> the raw https://sg.iherb.com/pr/... URL, unencoded."""
    if not wrapped_url:
        return None
    marker = "/destination:"
    idx = wrapped_url.find(marker)
    if idx == -1:
        return wrapped_url  # already raw, or an unexpected format — pass through
    raw = wrapped_url[idx + len(marker):]
    return unquote(raw)


def iherb_in_stock(inventory_field):
    if not inventory_field:
        return None
    return 1 if ">0" in inventory_field else 0


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

def ingest_shopee(conn, country, csv_path):
    print(f"[shopee:{country}] reading {csv_path} ...")
    t0 = time.time()
    n = 0
    buf = []
    currency = {"SG": "SGD", "MY": "MYR", "PH": "PHP", "TH": "THB", "TW": "TWD", "ID": "IDR"}.get(country, "USD")

    insert_sql = """
        INSERT OR REPLACE INTO products
        (merchant, country, product_id, shop_id, title, description, category, brand,
         price, sale_price, currency, rating, sold_count, stock, is_official, is_preferred,
         image_url, product_url, last_updated)
        VALUES ('shopee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    """

    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(strip_nuls(f))
        for row in reader:
            itemid = row.get("itemid")
            if not itemid:
                continue
            product_url = (row.get("product_link") or "").strip() or None
            buf.append((
                country,
                itemid,
                row.get("shopid"),
                row.get("title"),
                truncate(row.get("description")),
                row.get("global_category1"),
                row.get("global_brand") or None,
                to_float(row.get("price")),
                to_float(row.get("sale_price")),
                currency,
                to_float(row.get("item_rating")),
                to_int(row.get("item_sold")),
                to_int(row.get("stock")),
                to_bool_int(row.get("is_official_shop")),
                to_bool_int(row.get("is_preferred_shop")),
                row.get("image_link"),
                product_url,
            ))
            n += 1
            if len(buf) >= BATCH:
                conn.executemany(insert_sql, buf)
                buf.clear()
                if n % 200000 == 0:
                    print(f"  {n:,} rows... ({time.time()-t0:.1f}s)")
        if buf:
            conn.executemany(insert_sql, buf)
    conn.commit()
    print(f"[shopee:{country}] inserted {n:,} rows in {time.time()-t0:.1f}s")


def ingest_iherb(conn, country, csv_path):
    print(f"[iherb:{country}] reading {csv_path} ...")
    t0 = time.time()
    n = 0
    buf = []
    currency = {"SG": "SGD", "MY": "MYR", "PH": "PHP"}.get(country, "USD")

    insert_sql = """
        INSERT OR REPLACE INTO products
        (merchant, country, product_id, shop_id, title, description, category, brand,
         price, sale_price, currency, rating, sold_count, stock, is_official, is_preferred,
         image_url, product_url, last_updated)
        VALUES ('iherb', ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, ?, ?, strftime('%s','now'))
    """

    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(strip_nuls(f), delimiter="|")
        for row in reader:
            product_id = row.get("productID")
            if not product_id:
                continue
            product_url = unwrap_iherb_url(row.get("url"))
            buf.append((
                country,
                product_id,
                row.get("title"),
                truncate(row.get("description")),
                row.get("category"),
                to_float(row.get("price")),
                currency,
                iherb_in_stock(row.get("inventory")),
                row.get("image"),
                product_url,
            ))
            n += 1
            if len(buf) >= BATCH:
                conn.executemany(insert_sql, buf)
                buf.clear()
        if buf:
            conn.executemany(insert_sql, buf)
    conn.commit()
    print(f"[iherb:{country}] inserted {n:,} rows in {time.time()-t0:.1f}s")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_country_path(spec):
    if ":" not in spec:
        raise ValueError(f"expected COUNTRY:PATH, got {spec!r}")
    country, path = spec.split(":", 1)
    return country.strip().upper(), path.strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shopee", action="append", default=[], help="COUNTRY:PATH, repeatable")
    ap.add_argument("--iherb", action="append", default=[], help="COUNTRY:PATH, repeatable")
    ap.add_argument("--out", default="products.sqlite")
    args = ap.parse_args()

    if not args.shopee and not args.iherb:
        print(__doc__)
        sys.exit(1)

    csv.field_size_limit(sys.maxsize)
    t0 = time.time()

    db_path = Path(args.out)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-200000")

    conn.execute("DROP TABLE IF EXISTS products_fts")
    conn.execute("DROP TABLE IF EXISTS products")
    conn.execute("""
    CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        merchant TEXT NOT NULL,
        country TEXT NOT NULL,
        product_id TEXT NOT NULL,
        shop_id TEXT,
        title TEXT,
        description TEXT,
        category TEXT,
        brand TEXT,
        price REAL,
        sale_price REAL,
        currency TEXT,
        rating REAL,
        sold_count INTEGER,
        stock INTEGER,
        is_official INTEGER,
        is_preferred INTEGER,
        image_url TEXT,
        product_url TEXT,
        last_updated INTEGER,
        UNIQUE(merchant, country, product_id)
    )
    """)

    for spec in args.shopee:
        country, path = parse_country_path(spec)
        ingest_shopee(conn, country, path)

    for spec in args.iherb:
        country, path = parse_country_path(spec)
        ingest_iherb(conn, country, path)

    total = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    print(f"Total rows: {total:,}")

    print("Building indexes...")
    conn.execute("CREATE INDEX idx_products_merchant_country ON products(merchant, country)")
    conn.execute("CREATE INDEX idx_products_country_price ON products(country, price)")
    conn.commit()

    print("Building FTS5 index...")
    conn.execute("""
        CREATE VIRTUAL TABLE products_fts USING fts5(
            title, description, category, brand,
            content='products', content_rowid='id'
        )
    """)
    conn.execute("""
        INSERT INTO products_fts(rowid, title, description, category, brand)
        SELECT id, title, description, category, brand FROM products
    """)
    conn.commit()

    print("Running ANALYZE + VACUUM...")
    conn.execute("ANALYZE")
    conn.commit()
    conn.execute("VACUUM")
    conn.close()

    size_mb = db_path.stat().st_size / (1024 * 1024)
    print(f"Done in {time.time()-t0:.1f}s total — {db_path} is {size_mb:.0f}MB")


if __name__ == "__main__":
    main()

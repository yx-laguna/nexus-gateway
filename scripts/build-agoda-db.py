#!/usr/bin/env python3
"""
Build (or rebuild) the slim, indexed agoda_hotels.sqlite from a fresh
Agoda_Hotels_EN.csv export. Run this offline whenever Agoda sends an updated
inventory CSV — the running bot never touches the CSV, only the .sqlite file.

Usage:
    python3 scripts/build-agoda-db.py path/to/Agoda_Hotels_EN.csv [output.sqlite]

Drops heavy/unused columns (photo1-5, formerly_name, translated_name, etc.),
truncates the long "overview" text field, and keeps only what the hotel
search/ranking pipeline needs: identity, location, rating, and a short
description snippet for Kimi to reason over.
"""
import csv
import sqlite3
import sys
import time
from pathlib import Path

OVERVIEW_MAX_CHARS = 400


def to_float(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def to_int(v):
    try:
        return int(float(v)) if v not in (None, "") else None
    except ValueError:
        return None


def strip_nuls(fileobj):
    # A handful of rows in the wild CSV contain embedded NUL bytes, which
    # trips up Python's csv module ("line contains NUL"). Strip them.
    for line in fileobj:
        if "\x00" in line:
            line = line.replace("\x00", "")
        yield line


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    csv_path = Path(sys.argv[1])
    db_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("agoda_hotels.sqlite")

    csv.field_size_limit(sys.maxsize)
    t0 = time.time()

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-200000")  # ~200MB page cache during build

    conn.execute("DROP TABLE IF EXISTS hotels")
    conn.execute("""
    CREATE TABLE hotels (
        hotel_id INTEGER PRIMARY KEY,
        hotel_name TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        countryisocode TEXT,
        star_rating REAL,
        longitude REAL,
        latitude REAL,
        city_id INTEGER,
        number_of_reviews INTEGER,
        rating_average REAL,
        rates_from REAL,
        rates_currency TEXT,
        accommodation_type TEXT,
        overview TEXT
    )
    """)

    insert_sql = """
        INSERT OR REPLACE INTO hotels
        (hotel_id, hotel_name, address, city, state, country, countryisocode,
         star_rating, longitude, latitude, city_id, number_of_reviews,
         rating_average, rates_from, rates_currency, accommodation_type, overview)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """

    BATCH = 20000
    buf = []
    n = 0

    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(strip_nuls(f))
        for row in reader:
            hotel_id = to_int(row.get("hotel_id"))
            if hotel_id is None:
                continue
            address = " ".join(
                p for p in [row.get("addressline1", "").strip(), row.get("addressline2", "").strip()] if p
            )
            overview = (row.get("overview") or "")[:OVERVIEW_MAX_CHARS]
            buf.append((
                hotel_id,
                row.get("hotel_name"),
                address,
                row.get("city"),
                row.get("state"),
                row.get("country"),
                row.get("countryisocode"),
                to_float(row.get("star_rating")),
                to_float(row.get("longitude")),
                to_float(row.get("latitude")),
                to_int(row.get("city_id")),
                to_int(row.get("number_of_reviews")),
                to_float(row.get("rating_average")),
                to_float(row.get("rates_from")),
                row.get("rates_currency"),
                row.get("accommodation_type"),
                overview,
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
    print(f"Inserted {n:,} rows in {time.time()-t0:.1f}s")

    print("Building indexes...")
    conn.execute("CREATE INDEX idx_hotels_city_id ON hotels(city_id)")
    conn.execute("CREATE INDEX idx_hotels_city_lower ON hotels(city COLLATE NOCASE)")
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

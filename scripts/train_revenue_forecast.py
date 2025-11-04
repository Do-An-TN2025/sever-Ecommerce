#!/usr/bin/env python3
"""Train a simple revenue forecast from paid orders and save forecast to MongoDB.

This script aggregates paid orders by day/month/year, computes a simple
seasonal + linear trend forecast (no external ML deps), and writes the
forecast result documents into an output collection (default: revenue_forecasts).

Usage example:
  python scripts/train_revenue_forecast.py --mongo-uri "mongodb://..." \
    --orders-collection orders --out-collection revenue_forecasts --period day --range 90 --horizon 30
"""
import argparse
import logging
from urllib.parse import urlparse, quote_plus
from datetime import datetime, timedelta
import math
import json

import numpy as np
from pymongo import MongoClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def build_client(uri):
    # support mongodb+srv and auth in URI
    return MongoClient(uri)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--mongo-uri", required=True)
    p.add_argument("--orders-collection", default="orders")
    p.add_argument("--out-collection", default="revenue_forecasts")
    p.add_argument("--period", choices=["day", "month", "year"], default="day")
    p.add_argument("--range", type=int, default=90, help="history length in units (days/months/years)")
    p.add_argument("--horizon", type=int, default=30, help="forecast horizon steps")
    return p.parse_args()


def agg_revenue_by_period(db, orders_coll, period, start_date):
    # Match paid orders and group
    match = {"paymentMethod.status": "paid", "createdAt": {"$gte": start_date}}

    if period == "day":
        group_id = {"year": {"$year": "$createdAt"}, "month": {"$month": "$createdAt"}, "day": {"$dayOfMonth": "$createdAt"}}
    elif period == "month":
        group_id = {"year": {"$year": "$createdAt"}, "month": {"$month": "$createdAt"}}
    else:
        group_id = {"year": {"$year": "$createdAt"}}

    pipeline = [
        {"$match": match},
        {"$group": {"_id": group_id, "revenue": {"$sum": "$totalAmount"}, "orders": {"$sum": 1}}},
        {"$sort": {"_id.year": 1, "_id.month": 1, "_id.day": 1}}
    ]

    rows = list(db[orders_coll].aggregate(pipeline))
    return rows


def label_from_id(doc_id, period):
    if period == "day":
        return f"{doc_id['year']:04d}-{doc_id['month']:02d}-{doc_id['day']:02d}"
    if period == "month":
        return f"{doc_id['year']:04d}-{doc_id['month']:02d}"
    return f"{doc_id['year']:04d}"


def format_label(dt, period):
    if period == "day":
        return dt.strftime("%Y-%m-%d")
    if period == "month":
        return dt.strftime("%Y-%m")
    return dt.strftime("%Y")


def linear_fit(xs, ys):
    xs = np.asarray(xs, dtype=float)
    ys = np.asarray(ys, dtype=float)
    n = len(xs)
    if n == 0:
        return 0.0, 0.0
    sx = xs.sum()
    sy = ys.sum()
    sxy = (xs * ys).sum()
    sx2 = (xs * xs).sum()
    denom = n * sx2 - sx * sx
    if abs(denom) < 1e-12:
        return float(sy / n), 0.0
    b = (n * sxy - sx * sy) / denom
    a = (sy - b * sx) / n
    return float(a), float(b)


def run_forecast(rows, period, history_start_date, range_len, horizon):
    # build map from label -> revenue
    rev_map = {}
    for r in rows:
        key = label_from_id(r['_id'], period)
        rev_map[key] = float(r.get('revenue', 0.0) or 0.0)

    labels = []
    values = []
    dates = []
    cur = datetime(year=history_start_date.year, month=history_start_date.month, day=history_start_date.day)
    for i in range(range_len):
        lbl = format_label(cur, period)
        labels.append(lbl)
        values.append(rev_map.get(lbl, 0.0))
        dates.append(cur)
        if period == 'day':
            cur = cur + timedelta(days=1)
        elif period == 'month':
            # increment month safely
            y = cur.year + (cur.month // 12)
            m = cur.month + 1
            if m > 12:
                m = 1
                y = cur.year + 1
            cur = cur.replace(year=y, month=m)
        else:
            cur = cur.replace(year=cur.year + 1)

    # seasonality
    seasonality = None
    if period == 'month':
        seasonality = [0.0] * 12
        counts = [0] * 12
        for dt, v in zip(dates, values):
            idx = dt.month - 1
            seasonality[idx] += v
            counts[idx] += 1
        overall = sum(values) / max(1, len(values))
        for i in range(12):
            seasonality[i] = (seasonality[i] / counts[i]) / overall if counts[i] else 1.0
    elif period == 'day':
        # weekday seasonality Sunday=0..Saturday=6
        seasonality = [0.0] * 7
        counts = [0] * 7
        for dt, v in zip(dates, values):
            idx = dt.weekday()  # Mon=0..Sun=6 -> keep as-is
            seasonality[idx] += v
            counts[idx] += 1
        overall = sum(values) / max(1, len(values))
        for i in range(7):
            seasonality[i] = (seasonality[i] / counts[i]) / overall if counts[i] else 1.0

    # deseasonalize
    deseason = list(values)
    if seasonality is not None:
        for i, dt in enumerate(dates):
            factor = 1.0
            if period == 'month':
                factor = seasonality[dt.month - 1] or 1.0
            elif period == 'day':
                factor = seasonality[dt.weekday()] or 1.0
            deseason[i] = values[i] / factor if factor else values[i]

    xs = list(range(len(deseason)))
    a, b = linear_fit(xs, deseason)

    # forecast horizon
    forecast_labels = []
    forecast_values = []
    last_date = dates[-1]
    next_date = last_date
    if period == 'day':
        next_date = last_date + timedelta(days=1)
    elif period == 'month':
        m = last_date.month + 1
        y = last_date.year
        if m > 12:
            m = 1
            y += 1
        next_date = last_date.replace(year=y, month=m)
    else:
        next_date = last_date.replace(year=last_date.year + 1)

    last_idx = len(xs) - 1
    for h in range(1, horizon + 1):
        xpred = last_idx + h
        deseason_pred = a + b * xpred
        if deseason_pred < 0:
            deseason_pred = 0.0
        factor = 1.0
        if seasonality is not None:
            if period == 'month':
                factor = seasonality[next_date.month - 1] or 1.0
            elif period == 'day':
                factor = seasonality[next_date.weekday()] or 1.0
        final = deseason_pred * factor
        forecast_labels.append(format_label(next_date, period))
        forecast_values.append(float(final))

        # increment next_date
        if period == 'day':
            next_date = next_date + timedelta(days=1)
        elif period == 'month':
            m = next_date.month + 1
            y = next_date.year
            if m > 12:
                m = 1
                y += 1
            next_date = next_date.replace(year=y, month=m)
        else:
            next_date = next_date.replace(year=next_date.year + 1)

    return {
        "history": {"labels": labels, "values": values},
        "forecast": {"labels": forecast_labels, "values": forecast_values},
        "model": {"intercept": a, "slope": b},
        "seasonality": seasonality
    }


def main():
    args = parse_args()
    client = build_client(args.mongo_uri)
    db = client.get_default_database()

    now = datetime.utcnow()
    # compute start date for history
    if args.period == 'day':
        start = now - timedelta(days=args.range - 1)
        # normalize to midnight
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    elif args.period == 'month':
        # go back N-1 months
        y = now.year
        m = now.month - (args.range - 1)
        while m <= 0:
            m += 12
            y -= 1
        start = now.replace(year=y, month=m, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start = now.replace(year=now.year - (args.range - 1), month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

    logger.info("Aggregating revenue from %s to now (period=%s)", start.isoformat(), args.period)
    rows = agg_revenue_by_period(db, args.orders_collection, args.period, start)

    result = run_forecast(rows, args.period, start, args.range, args.horizon)

    # store result into out collection
    doc = {
        "createdAt": datetime.utcnow(),
        "period": args.period,
        "range": args.range,
        "horizon": args.horizon,
        "history": result['history'],
        "forecast": result['forecast'],
        "model": result['model'],
        "seasonality": result['seasonality']
    }

    out_coll = db[args.out_collection]

    # Upsert behavior: replace existing forecast for same period/range/horizon
    filter_q = {"period": args.period, "range": args.range, "horizon": args.horizon}
    # set createdAt to now for this run
    doc["createdAt"] = datetime.utcnow()

    result = out_coll.replace_one(filter_q, doc, upsert=True)
    # fetch the document to get its _id (either existing or newly upserted)
    stored = out_coll.find_one(filter_q)
    logger.info("Upserted forecast document into %s (matched=%s upsertedId=%s id=%s)",
                args.out_collection, result.matched_count, getattr(result, 'upserted_id', None), stored.get('_id') if stored else None)
    print(json.dumps({"ok": True, "forecast_doc_id": str(stored.get('_id')) if stored else None}))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Train a revenue forecast using ARIMA/SARIMA and save forecast to MongoDB.

This script is a separate ARIMA implementation. It accepts similar CLI args
as the linear script and will upsert the forecast document into the target
collection. If pmdarima is available it will use auto_arima to select orders;
otherwise it falls back to statsmodels SARIMAX with sensible defaults.

Usage:
  python scripts/train_revenue_forecast_arima.py --mongo-uri "mongodb://..." \
    --orders-collection orders --out-collection revenue_forecasts --period day --range 90 --horizon 30
"""
import argparse
import logging
from datetime import datetime, timedelta
import json
import sys

import numpy as np
from pymongo import MongoClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def build_client(uri):
    return MongoClient(uri)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--mongo-uri", required=True)
    p.add_argument("--orders-collection", default="orders")
    p.add_argument("--out-collection", default="revenue_forecasts")
    p.add_argument("--period", choices=["day", "month", "year"], default="day")
    p.add_argument("--range", type=int, default=90)
    p.add_argument("--horizon", type=int, default=30)
    p.add_argument("--max-auto-time", type=int, default=120, help="max seconds for auto_arima search (best-effort)")
    return p.parse_args()


def agg_revenue_by_period(db, orders_coll, period, start_date):
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


def build_series(rows, period, history_start_date, range_len):
    # Build continuous series and return (dates, values, labels)
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
            # increment month safely: move to day=1 then add month
            y = cur.year
            m = cur.month + 1
            if m > 12:
                m = 1
                y += 1
            cur = cur.replace(year=y, month=m, day=1)
        else:
            cur = cur.replace(year=cur.year + 1, month=1, day=1)

    return dates, values, labels


def run_arima_forecast(rows, period, history_start_date, range_len, horizon, max_auto_time):
    try:
        import pandas as pd
    except Exception:
        logger.error("pandas is required for ARIMA script. Please install pandas.")
        raise

    dates, values, labels = build_series(rows, period, history_start_date, range_len)
    # build pandas Series and set explicit frequency for stability
    idx = pd.to_datetime(labels)
    # infer freq based on period
    freq = 'D' if period == 'day' else ('MS' if period == 'month' else 'YS')
    try:
        idx = pd.DatetimeIndex(idx).asfreq(freq)
    except Exception:
        # fallback to DatetimeIndex without freq
        idx = pd.DatetimeIndex(idx)
    series = pd.Series(values, index=idx).astype(float)

    # compute history stats
    total_revenue = float(series.sum())
    nonzero_count = int((series > 0).sum())
    pct_zero = 1.0 - (nonzero_count / max(1, len(series)))

    history_stats = {
        'total_revenue': total_revenue,
        'nonzero_count': nonzero_count,
        'pct_zero': pct_zero,
        'length': len(series)
    }

    # seasonality period
    if period == 'month':
        m = 12
    elif period == 'day':
        m = 7
    else:
        m = 1

    # If history too short for seasonality, disable seasonal modeling
    use_seasonal = True
    if len(series) < max(2 * m, 8):
        use_seasonal = False

    # We'll try pmdarima.auto_arima first (auto model selection)
    arima_res = None
    model_meta = {}
    forecast_mean = None
    forecast_ci = None

    # simple holdout to estimate performance
    holdout_k = max(1, min(14, int(len(series) * 0.15))) if len(series) > 3 else 1
    train = series.iloc[:-holdout_k] if holdout_k < len(series) else series.iloc[:-1]
    test = series.iloc[-holdout_k:]

    try:
        import pmdarima as pm
        logger.info("Running pmdarima.auto_arima (may take seconds)...")
        arima = pm.auto_arima(train, seasonal=use_seasonal and (m > 1), m=(m if use_seasonal and m > 1 else None),
                              stepwise=True, max_p=3, max_q=3, max_P=2, max_Q=2,
                              error_action='warn', trace=False, suppress_warnings=True)

        model_meta['type'] = 'pmdarima'
        model_meta['order'] = arima.order()
        model_meta['seasonal_order'] = arima.seasonal_order()
        model_meta['aic'] = float(getattr(arima, 'aic', float('nan')))

        # backtest on holdout
        try:
            preds, conf = arima.predict(n_periods=holdout_k, return_conf_int=True)
            mse = float(np.mean((preds - test.values) ** 2))
        except Exception:
            mse = None

        # fit on full series then forecast horizon
        arima.update(series)
        preds_future, conf_future = arima.predict(n_periods=horizon, return_conf_int=True)
        forecast_mean = [float(x) for x in preds_future]
        forecast_ci = [[float(low), float(high)] for low, high in conf_future]
        model_meta['mse_holdout'] = mse
        model_meta['summary'] = str(arima)

    except Exception as e:
        logger.warning("pmdarima failed or not installed; falling back to statsmodels SARIMAX (%s)", e)
        try:
            from statsmodels.tsa.statespace.sarimax import SARIMAX
            # choose simple order
            order = (1, 1, 1)
            seasonal_order = (1, 0, 1, m) if use_seasonal and m > 1 else (0, 0, 0, 0)
            model = SARIMAX(train, order=order, seasonal_order=seasonal_order, enforce_stationarity=False, enforce_invertibility=False)
            fitted = model.fit(disp=False)
            # backtest
            try:
                preds = fitted.forecast(steps=holdout_k)
                mse = float(np.mean((preds - test.values) ** 2))
            except Exception:
                mse = None

            # refit on full series
            model_full = SARIMAX(series, order=order, seasonal_order=seasonal_order, enforce_stationarity=False, enforce_invertibility=False)
            fitted_full = model_full.fit(disp=False)
            preds_future = fitted_full.get_forecast(steps=horizon)
            forecast_mean = [float(x) for x in preds_future.predicted_mean]
            ci = preds_future.conf_int()
            forecast_ci = [[float(row[0]), float(row[1])] for row in ci.values]
            model_meta = {'type': 'statsmodels', 'order': order, 'seasonal_order': seasonal_order, 'mse_holdout': mse, 'aic': float(getattr(fitted_full, 'aic', float('nan')))}
        except Exception as ex:
            logger.error("ARIMA fallback failed: %s", ex)
            # as last resort, return simple linear forecast similar to original script
            from math import floor
            xs = list(range(len(series)))
            ys = series.values.tolist()
            # linear fit
            sx = sum(xs)
            sy = sum(ys)
            sxy = sum(x * y for x, y in zip(xs, ys))
            sx2 = sum(x * x for x in xs)
            n = len(xs)
            denom = n * sx2 - sx * sx
            if abs(denom) < 1e-12:
                a = float(sy / n)
                b = 0.0
            else:
                b = (n * sxy - sx * sy) / denom
                a = (sy - b * sx) / n

            last_idx = xs[-1]
            forecast_mean = []
            forecast_ci = []
            for h in range(1, horizon + 1):
                val = max(0.0, a + b * (last_idx + h))
                forecast_mean.append(float(val))
                # naive conf interval +-20%
                forecast_ci.append([float(val * 0.8), float(val * 1.2)])
            model_meta = {'type': 'fallback_linear', 'intercept': a, 'slope': b}

    # build history dict to be consistent with existing script
    history = {"labels": [d.strftime('%Y-%m-%d') if period == 'day' else (d.strftime('%Y-%m') if period == 'month' else d.strftime('%Y')) for d in dates],
               "values": [float(v) for v in values],
               "stats": history_stats}

    # clamp forecast and adjust conf_int lower bounds to >=0
    forecast = {"labels": [], "values": [], "conf_int": []}
    # build labels for future dates starting after last date
    last_date = dates[-1]
    next_date = last_date
    for h in range(1, horizon + 1):
        if period == 'day':
            next_date = next_date + timedelta(days=1)
        elif period == 'month':
            mth = next_date.month + 1
            y = next_date.year
            if mth > 12:
                mth = 1
                y += 1
            next_date = next_date.replace(year=y, month=mth, day=1)
        else:
            next_date = next_date.replace(year=next_date.year + 1, month=1, day=1)
        forecast['labels'].append(format_label(next_date, period))

    # clamp negative values and conf_int
    clamped_values = [max(0.0, float(v)) for v in (forecast_mean or [])]
    if forecast_ci:
        clamped_ci = []
        for row in forecast_ci:
            low = max(0.0, float(row[0]))
            high = max(low, float(row[1]))
            clamped_ci.append([low, high])
    else:
        clamped_ci = []

    forecast['values'] = clamped_values
    forecast['conf_int'] = clamped_ci

    # include warning if data too sparse or mse too large
    warnings = []
    if history_stats['nonzero_count'] < max(2, int(0.05 * history_stats['length'])):
        warnings.append('sparse_history')
    if model_meta.get('mse_holdout') is not None and model_meta.get('mse_holdout') > 1e10:
        warnings.append('high_mse')

    return {"history": history, "forecast": forecast, "model": model_meta, "warnings": warnings}


def main():
    args = parse_args()
    client = build_client(args.mongo_uri)
    db = client.get_default_database()

    now = datetime.utcnow()
    if args.period == 'day':
        start = now - timedelta(days=args.range - 1)
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    elif args.period == 'month':
        y = now.year
        m = now.month - (args.range - 1)
        while m <= 0:
            m += 12
            y -= 1
        start = now.replace(year=y, month=m, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start = now.replace(year=now.year - (args.range - 1), month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

    logger.info("Aggregating revenue for ARIMA from %s to now (period=%s)", start.isoformat(), args.period)
    rows = agg_revenue_by_period(db, args.orders_collection, args.period, start)

    try:
        result = run_arima_forecast(rows, args.period, start, args.range, args.horizon, args.max_auto_time)
    except Exception as e:
        logger.exception("Forecast failed: %s", e)
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(2)

    doc = {"createdAt": datetime.utcnow(), "period": args.period, "range": args.range, "horizon": args.horizon,
           "history": result['history'], "forecast": result['forecast'], "model": result['model']}

    out_coll = db[args.out_collection]
    filter_q = {"period": args.period, "range": args.range, "horizon": args.horizon}
    out_coll.replace_one(filter_q, doc, upsert=True)
    stored = out_coll.find_one(filter_q)
    print(json.dumps({"ok": True, "forecast_doc_id": str(stored.get('_id')) if stored else None}))


if __name__ == '__main__':
    main()

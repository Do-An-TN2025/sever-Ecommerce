"""
Train implicit ALS on orders and write top-K item neighbors to MongoDB.
Usage:
  python scripts/train_als.py --mongo-uri "<MONGO_URI>" --orders-collection orders --out-collection cfrecommendations --topk 12
"""
import argparse
import logging
from urllib.parse import urlparse, quote_plus, urlunparse
from datetime import datetime

import numpy as np
from scipy.sparse import coo_matrix
from tqdm import tqdm

# implicit library (ALS for implicit feedback)
import implicit

from pymongo import MongoClient, UpdateOne
from bson import ObjectId

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def build_client(mongo_uri):
    """Create MongoClient; percent-encode password if needed."""
    try:
        return MongoClient(mongo_uri)
    except Exception:
        parsed = urlparse(mongo_uri)
        if parsed.username and parsed.password:
            user = parsed.username
            pwd = quote_plus(parsed.password)
            netloc = f"{user}:{pwd}@{parsed.hostname or ''}"
            if parsed.port:
                netloc += f":{parsed.port}"
            new_uri = urlunparse((parsed.scheme, netloc, parsed.path or "", "", parsed.query or "", ""))
            logger.info("Retrying MongoClient with percent-encoded password.")
            return MongoClient(new_uri)
        raise


def load_orders_collection(mongo_uri, db_name=None, orders_collection="orders"):
    client = build_client(mongo_uri)
    db = client[db_name] if db_name else client.get_default_database()
    coll = db[orders_collection]
    logger.info("Connected to DB='%s' collection='%s'", db.name, orders_collection)
    return coll, db


def extract_product_id(item):
    """Return a product id string from an order item (robust to schema variants)."""
    if item is None:
        return None
    # If item is a dict try common keys
    if isinstance(item, dict):
        # common fields observed: productId, product, _id, product._id, productId._id
        for key in ("productId", "product_id", "productId_str", "product", "_id", "id"):
            val = item.get(key)
            if val:
                # if nested doc with _id
                if isinstance(val, dict):
                    nested = val.get("_id") or val.get("id")
                    if nested:
                        return str(nested)
                    # fallback to string of val
                    return str(val)
                return str(val)
        # some schemas store product reference under 'variant' or 'productRef'
        for key in ("variant", "productRef", "product_id"):
            val = item.get(key)
            if val:
                return str(val)
        return None
    # If item is a plain id
    return str(item)


def load_variant_map(db):
    """Load map variant_id -> parent product id (if collection exists)."""
    variant_map = {}
    if not db:
        return variant_map
    try:
        if "productvariants" in db.list_collection_names():
            for v in db["productvariants"].find({}, {"_id": 1, "productId": 1, "product": 1}):
                vid = str(v.get("_id"))
                pid = v.get("productId") or v.get("product")
                if pid:
                    variant_map[vid] = str(pid)
    except Exception:
        pass
    return variant_map


def build_interactions(order_coll, db=None, sample_limit=1000, debug_limit=10):
    """
    Build item x user interaction sparse matrix.
    If sample_limit <= 0 => scan all documents.
    """
    variant_map = load_variant_map(db)
    user_map = {}
    item_map = {}
    rows = []
    cols = []
    data = []
    user_cnt = 0
    item_cnt = 0
    processed = 0
    sample_logs = []

    # use no limit when sample_limit <= 0
    if sample_limit and sample_limit > 0:
        cursor = order_coll.find().limit(sample_limit)
    else:
        cursor = order_coll.find()

    for o in cursor:
        processed += 1
        # try common user id keys
        uid = o.get("user") or o.get("userId") or o.get("user_id") or o.get("customer") or o.get("customerId")
        items = o.get("items") or o.get("orderItems") or o.get("products") or o.get("itemsList") or []
        pids = set()
        for it in items:
            pid = extract_product_id(it)
            # map variant id -> parent product id if available
            if pid and pid in variant_map:
                pid = variant_map[pid]
            if pid:
                pids.add(pid)
        if not uid or not pids:
            if len(sample_logs) < debug_limit:
                sample_logs.append({"_id": str(o.get("_id")), "uid": uid, "extracted_pids": list(pids), "raw_items_sample": items[:3]})
            continue
        u = str(uid)
        if u not in user_map:
            user_map[u] = user_cnt
            user_cnt += 1
        for pid in pids:
            if pid not in item_map:
                item_map[pid] = item_cnt
                item_cnt += 1
            rows.append(item_map[pid])
            cols.append(user_map[u])
            data.append(1.0)
        if processed <= debug_limit:
            sample_logs.append({"_id": str(o.get("_id")), "uid": u, "pids_count": len(pids)})

    logger.info("processed_orders_sample=%d users_found=%d items_found=%d", processed, user_cnt, item_cnt)
    if sample_logs:
        logger.debug("sample logs (first orders):")
        for s in sample_logs:
            logger.debug("  %s", s)

    if item_cnt == 0 or user_cnt == 0:
        return user_map, item_map, coo_matrix((0, 0))

    mat = coo_matrix((np.array(data, dtype=np.float32), (np.array(rows, dtype=np.int32), np.array(cols, dtype=np.int32))),
                     shape=(item_cnt, user_cnt))
    return user_map, item_map, mat


def train_als(mat, factors=64, regularization=0.01, iterations=15):
    """Train implicit ALS model. mat must be item x user sparse matrix."""
    if mat.shape[0] == 0 or mat.shape[1] == 0:
        raise ValueError("Empty interaction matrix")
    mat_csr = mat.tocsr().astype("float32")
    model = implicit.als.AlternatingLeastSquares(factors=factors,
                                                 regularization=regularization,
                                                 iterations=iterations)
    # implicit expects item-user matrix
    model.fit(mat_csr)
    return model


def compute_topk_neighbors(model, item_map, topk=12):
    """Compute top-K similar items (cosine) from item_factors."""
    inv_item_map = {v: k for k, v in item_map.items()}
    item_factors = model.item_factors  # shape (n_items, factors)
    norms = np.linalg.norm(item_factors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normed = item_factors / norms
    sims_topk = {}

    n = normed.shape[0]
    for i in tqdm(range(n), desc="computing similarities"):
        vec = normed[i : i + 1]
        sims = (normed @ vec.T).ravel()
        if sims.size > 0:
            sims[i] = -np.inf  # ignore self
        k = min(topk, max(0, sims.size - 1))
        if k <= 0:
            top_idx = np.array([], dtype=int)
        else:
            if k == 1:
                top_idx = np.array([int(np.argmax(sims))], dtype=int)
            else:
                # Argpartition requires integer kth; ensure within bounds
                kth = k
                if kth >= sims.size:
                    kth = sims.size - 1
                top_idx = np.argpartition(-sims, kth)[:k]
        top_sorted = sorted(((int(j), float(sims[j])) for j in top_idx), key=lambda x: -x[1])
        neighbors = []
        for j, score in top_sorted:
            neighbors.append((inv_item_map[j], score))
        sims_topk[inv_item_map[i]] = neighbors
    return sims_topk


def write_to_mongo(db, collection_name, sims_topk):
    """Upsert recommendations into MongoDB using UpdateOne operations."""
    coll = db[collection_name]
    ops = []
    for pid, neighbors in sims_topk.items():
        # try convert ids to ObjectId when appropriate
        try:
            prod_key = ObjectId(pid)
        except Exception:
            prod_key = pid
        recs = []
        for nid, score in neighbors:
            try:
                recs.append({"product": ObjectId(nid), "score": float(score)})
            except Exception:
                recs.append({"product": nid, "score": float(score)})
        ops.append(UpdateOne({"product": prod_key},
                             {"$set": {"recommendations": recs, "updatedAt": datetime.utcnow()}},
                             upsert=True))
        if len(ops) >= 500:
            coll.bulk_write(ops)
            ops = []
    if ops:
        coll.bulk_write(ops)
    logger.info("Wrote %d recommendation docs to collection '%s'.", len(sims_topk), collection_name)


def get_top_products_from_orders(order_coll, limit=100):
    """Return list of top product ids (strings) ordered by frequency."""
    pipeline = [
        {"$unwind": "$items"},
        {"$project": {"pid": {"$ifNull": ["$items.productId", "$items.product"]}}},
        {"$match": {"pid": {"$ne": None}}},
        {"$group": {"_id": {"$toString": "$pid"}, "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": limit}
    ]
    res = list(order_coll.aggregate(pipeline))
    return [r["_id"] for r in res]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mongo-uri", required=True, help="MongoDB connection URI")
    parser.add_argument("--db-name", default=None, help="Database name (optional)")
    parser.add_argument("--orders-collection", default="orders", help="Orders collection name")
    parser.add_argument("--out-collection", default="cfrecommendations", help="Output recommendations collection")
    parser.add_argument("--factors", type=int, default=64)
    parser.add_argument("--regularization", type=float, default=0.01)
    parser.add_argument("--iterations", type=int, default=15)
    parser.add_argument("--topk", type=int, default=12)
    parser.add_argument("--sample-limit", type=int, default=50000, help="How many orders to scan (use small for debug)")
    args = parser.parse_args()

    order_coll, db = load_orders_collection(args.mongo_uri, args.db_name, args.orders_collection)
    user_map, item_map, mat = build_interactions(order_coll, sample_limit=args.sample_limit)
    logger.info("Matrix shape: %s", mat.shape)
    if mat.shape[0] == 0 or mat.shape[1] == 0:
        logger.info("No interactions found; exiting.")
        return

    model = train_als(mat, factors=args.factors, regularization=args.regularization, iterations=args.iterations)
    sims = compute_topk_neighbors(model, item_map, topk=args.topk)

    # fallback: fill empty neighbors with global top-selling products
    top_global = get_top_products_from_orders(order_coll, limit=max(50, args.topk*3))
    for pid in list(sims.keys()):
        if not sims.get(pid):
            # take top_global excluding the pid itself
            fallback = []
            for t in top_global:
                if t == pid:
                    continue
                fallback.append((t, 0.0))
                if len(fallback) >= args.topk:
                    break
            sims[pid] = fallback

    write_to_mongo(db, args.out_collection, sims)
    logger.info("Done.")


if __name__ == "__main__":
    main()
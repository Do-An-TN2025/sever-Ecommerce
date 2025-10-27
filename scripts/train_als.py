import argparse
import logging
from urllib.parse import urlparse, quote_plus, urlunparse
from datetime import datetime

import numpy as np
from scipy.sparse import coo_matrix
from tqdm import tqdm

# implicit ALS library
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
    """Return a product id string from an order/cart item (robust to schema variants)."""
    if item is None:
        return None
    if isinstance(item, dict):
        # common keys
        for key in ("productId", "product_id", "product", "_id", "id"):
            val = item.get(key)
            if val:
                if isinstance(val, dict):
                    nested = val.get("_id") or val.get("id")
                    if nested:
                        return str(nested)
                    return str(val)
                return str(val)
        # fallback common nested keys
        for key in ("variantId", "variant", "productRef"):
            val = item.get(key)
            if val:
                return str(val)
        return None
    return str(item)


def load_variant_map(db):
    """Load variant_id -> parent productId mapping from productvariants collection if available."""
    variant_map = {}
    if db is None:
        return variant_map
    try:
        if "productvariants" in db.list_collection_names():
            for v in db["productvariants"].find({}, {"_id": 1, "productId": 1, "product": 1}):
                vid = str(v.get("_id"))
                pid = v.get("productId") or v.get("product")
                if pid:
                    variant_map[vid] = str(pid)
    except Exception:
        logger.debug("Failed to load variant map", exc_info=True)
    return variant_map


def build_interactions_from_interactions_coll(db, interactions_coll_name="interactions", sample_limit=0, debug_limit=10):
    """
    Aggregate interactions collection into user-product weights and build item x user sparse matrix.
    Expected documents: { userId?, sessionId?, productId, weight }
    """
    try:
        # db may be a Database object; check explicitly against None before using
        if db is None:
            return None
        if interactions_coll_name not in db.list_collection_names():
            return None
    except Exception:
        return None

    coll = db[interactions_coll_name]
    pipeline = [
        {"$group": {
            "_id": {"user": {"$ifNull": ["$userId", "$sessionId"]}, "product": "$productId"},
            "weight": {"$sum": {"$ifNull": ["$weight", 1]}}
        }},
        {"$project": {"user": "$_id.user", "product": {"$toString": "$_id.product"}, "weight": 1}}
    ]
    if sample_limit and sample_limit > 0:
        pipeline.insert(0, {"$limit": sample_limit})

    agg = coll.aggregate(pipeline, allowDiskUse=True)
    user_map = {}
    item_map = {}
    rows = []
    cols = []
    data = []
    user_cnt = 0
    item_cnt = 0
    processed = 0
    sample_logs = []

    for doc in agg:
        processed += 1
        u = doc.get("user")
        pid = doc.get("product")
        w = float(doc.get("weight", 1.0))
        if u is None or pid is None:
            if len(sample_logs) < debug_limit:
                sample_logs.append(doc)
            continue
        u_s = str(u)
        pid_s = str(pid)
        if u_s not in user_map:
            user_map[u_s] = user_cnt
            user_cnt += 1
        if pid_s not in item_map:
            item_map[pid_s] = item_cnt
            item_cnt += 1
        rows.append(item_map[pid_s])
        cols.append(user_map[u_s])
        data.append(w)

    logger.info("interactions agg processed=%d users_found=%d items_found=%d", processed, user_cnt, item_cnt)
    if sample_logs:
        logger.debug("sample interaction rows: %s", sample_logs[:min(len(sample_logs), debug_limit)])

    if item_cnt == 0 or user_cnt == 0:
        return {}, {}, coo_matrix((0, 0))

    mat = coo_matrix((np.array(data, dtype=np.float32),
                      (np.array(rows, dtype=np.int32), np.array(cols, dtype=np.int32))),
                     shape=(item_cnt, user_cnt))
    return user_map, item_map, mat


def build_interactions(order_coll, db=None, sample_limit=1000, debug_limit=10):
    """
    Aggregate user x product implicit weights from multiple sources:
      - interactions (preferred)
      - carts (guestId/sessionId or userId)  -> weight 2.0
      - wishlists (user saved wishlist)      -> weight 1.5
      - orders (purchases)                   -> weight 3.0
    If sample_limit <= 0 => scan whole collections.
    Returns user_map, item_map, coo_matrix(items x users)
    """
    if db is None:
        return {}, {}, coo_matrix((0, 0))

    def add_row(u, pid, w, user_map, item_map, rows, cols, data):
        if u is None or pid is None:
            return
        u_s = str(u); p_s = str(pid)
        if u_s not in user_map:
            user_map[u_s] = len(user_map)
        if p_s not in item_map:
            item_map[p_s] = len(item_map)
        rows.append(item_map[p_s]); cols.append(user_map[u_s]); data.append(float(w))

    user_map = {}; item_map = {}
    rows = []; cols = []; data = []
    sample_logs = []; processed = 0

    # 1) interactions collection (explicit events, has weight)
    try:
        if "interactions" in db.list_collection_names():
            coll = db["interactions"]
            cursor = coll.find() if (not sample_limit or sample_limit <= 0) else coll.find().limit(sample_limit)
            for doc in cursor:
                processed += 1
                u = doc.get("userId") or doc.get("sessionId")
                pid = doc.get("productId") or doc.get("product")
                w = doc.get("weight", 1.0)
                add_row(u, pid, w, user_map, item_map, rows, cols, data)
                if processed <= debug_limit:
                    sample_logs.append({"src":"interactions","user":u,"pid":pid,"w":w})
    except Exception:
        pass

    # 2) carts (weight 2.0)
    try:
        if len(item_map) < 2 and "carts" in db.list_collection_names():
            coll = db["carts"]
            cursor = coll.find() if (not sample_limit or sample_limit <= 0) else coll.find().limit(sample_limit)
            for c in cursor:
                processed += 1
                u = c.get("userId") or c.get("guestId") or c.get("sessionId")
                items = c.get("items") or []
                for it in items:
                    pid = it.get("productId") or it.get("product")
                    add_row(u, pid, 2.0, user_map, item_map, rows, cols, data)
                if processed <= debug_limit:
                    sample_logs.append({"src":"carts","user":u,"sample_items":(items[:2])})
    except Exception:
        pass

    # 3) wishlists - check collection 'wishlists' or field 'wishlist' in users (weight 1.5)
    try:
        if len(item_map) < 2:
            if "wishlists" in db.list_collection_names():
                coll = db["wishlists"]
                cursor = coll.find() if (not sample_limit or sample_limit <= 0) else coll.find().limit(sample_limit)
                for wdoc in cursor:
                    processed += 1
                    u = wdoc.get("userId")
                    pid = wdoc.get("productId") or wdoc.get("product")
                    add_row(u, pid, 1.5, user_map, item_map, rows, cols, data)
            else:
                # users.wishlist array
                if "users" in db.list_collection_names():
                    cursor = db["users"].find({"wishlist": {"$exists": True, "$ne": []}}, {"_id":1, "wishlist":1})
                    for udoc in cursor:
                        processed += 1
                        u = udoc.get("_id")
                        for pid in udoc.get("wishlist", [])[:100]:
                            add_row(u, pid, 1.5, user_map, item_map, rows, cols, data)
                        if processed <= debug_limit:
                            sample_logs.append({"src":"users.wishlist","user":u,"count":len(udoc.get("wishlist",[]))})
    except Exception:
        pass

    # 4) orders (purchase weight 3.0)
    try:
        if len(item_map) < 2 and order_coll is not None:
            cursor = order_coll.find() if (not sample_limit or sample_limit <= 0) else order_coll.find().limit(sample_limit)
            for o in cursor:
                processed += 1
                u = o.get("user") or o.get("userId") or o.get("customer") or o.get("user_id")
                items = o.get("items") or []
                for it in items:
                    pid = it.get("productId") or it.get("product")
                    add_row(u, pid, 3.0, user_map, item_map, rows, cols, data)
                if processed <= debug_limit:
                    sample_logs.append({"src":"orders","user":u,"sample_items":items[:2]})
    except Exception:
        pass

    logger.info("build_interactions: processed=%d users=%d items=%d", processed, len(user_map), len(item_map))
    if sample_logs:
        logger.debug("sample rows: %s", sample_logs[:min(len(sample_logs), debug_limit)])

    if len(user_map) == 0 or len(item_map) == 0:
        return user_map, item_map, coo_matrix((0,0))

    mat = coo_matrix((np.array(data, dtype=np.float32), (np.array(rows, dtype=np.int32), np.array(cols, dtype=np.int32))),
                     shape=(len(item_map), len(user_map)))
    return user_map, item_map, mat


def train_als(mat, factors=64, regularization=0.01, iterations=15):
    """Train implicit ALS model. mat must be item x user sparse matrix."""
    if mat.shape[0] == 0 or mat.shape[1] == 0:
        raise ValueError("Empty interaction matrix")
    mat_csr = mat.tocsr().astype("float32")
    model = implicit.als.AlternatingLeastSquares(factors=factors,
                                                 regularization=regularization,
                                                 iterations=iterations)
    # implicit expects (item x user) matrix
    model.fit(mat_csr)
    return model


def compute_topk_neighbors(model, item_map, topk=12):
    """Compute top-K similar items (cosine) from item_factors (robust to index mismatches)."""
    # inv map: index -> productId
    inv_item_map = {v: k for k, v in item_map.items()}
    item_factors = model.item_factors  # shape (n_items_model, factors)
    norms = np.linalg.norm(item_factors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normed = item_factors / norms
    sims_topk = {}

    # iterate only over indices that exist in inv_item_map
    valid_indices = sorted(inv_item_map.keys())
    n_model = normed.shape[0]

    for idx in tqdm(valid_indices, desc="computing similarities"):
        if idx < 0 or idx >= n_model:
            # skip indices that are out of bounds for model factors
            continue
        pid = inv_item_map[idx]
        vec = normed[idx: idx + 1]  # 1 x F
        sims = (normed @ vec.T).ravel()
        # ignore self (if self index exists)
        if idx < sims.size:
            sims[idx] = -np.inf

        # filter candidate indices to those present in inv_item_map
        # create mask of valid neighbor indices
        candidate_idxs = [j for j in range(sims.size) if j in inv_item_map and j != idx]
        if not candidate_idxs:
            sims_topk[pid] = []
            continue

        # collect scores only for candidate indices
        cand_scores = np.array([sims[j] for j in candidate_idxs], dtype=float)
        k = min(topk, len(cand_scores))
        if k <= 0:
            sims_topk[pid] = []
            continue

        if k == 1:
            # pick best among candidates
            best_pos = int(np.argmax(cand_scores))
            sel_idx = candidate_idxs[best_pos]
            top_selected = [sel_idx]
        else:
            # argpartition on candidate scores then map back to global indices
            kth = k - 1
            # argpartition on cand_scores
            part = np.argpartition(-cand_scores, kth)[:k]
            top_selected = [candidate_idxs[p] for p in part]

        # sort selected by score desc
        top_sorted = sorted(((int(j), float(sims[j])) for j in top_selected), key=lambda x: -x[1])
        neighbors = []
        for j, score in top_sorted:
            # safe map j -> product id
            if j in inv_item_map:
                neighbors.append((inv_item_map[j], score))
        sims_topk[pid] = neighbors

    return sims_topk


def write_to_mongo(db, collection_name, sims_topk):
    """Upsert recommendations into MongoDB using UpdateOne operations."""
    coll = db[collection_name]
    ops = []
    for pid, neighbors in sims_topk.items():
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
    """Return list of top product ids (strings) ordered by frequency from orders."""
    pipeline = [
        {"$unwind": "$items"},
        {"$project": {"pid": {"$ifNull": ["$items.productId", "$items.product"]}}},
        {"$match": {"pid": {"$ne": None}}},
        {"$group": {"_id": {"$toString": "$pid"}, "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": limit}
    ]
    try:
        res = list(order_coll.aggregate(pipeline))
        return [r["_id"] for r in res]
    except Exception:
        return []


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
    parser.add_argument("--sample-limit", type=int, default=50000, help="How many docs to scan (0 or negative = all)")
    args = parser.parse_args()

    order_coll, db = load_orders_collection(args.mongo_uri, args.db_name, args.orders_collection)
    user_map, item_map, mat = build_interactions(order_coll, db=db, sample_limit=args.sample_limit)
    logger.info("Matrix shape: %s", mat.shape)
    if mat.shape[0] == 0 or mat.shape[1] == 0:
        logger.info("No interactions found; exiting.")
        return

    logger.info("Training ALS (factors=%d, reg=%s, iters=%d)...", args.factors, args.regularization, args.iterations)
    model = train_als(mat, factors=args.factors, regularization=args.regularization, iterations=args.iterations)

    logger.info("Computing top-%d neighbors...", args.topk)
    sims = compute_topk_neighbors(model, item_map, topk=args.topk)

    # fallback: fill empty neighbors with global top-selling products
    top_global = get_top_products_from_orders(order_coll, limit=max(50, args.topk * 3))
    for pid in list(sims.keys()):
        if not sims.get(pid):
            fallback = []
            for t in top_global:
                if t == pid:
                    continue
                fallback.append((t, 0.0))
                if len(fallback) >= args.topk:
                    break
            sims[pid] = fallback

    logger.info("Writing recommendations to MongoDB collection '%s'...", args.out_collection)
    write_to_mongo(db, args.out_collection, sims)
    logger.info("Done.")


if __name__ == "__main__":
    main()
const Cart = require('../models/Cart');
const ProductVariant = require('../models/ProductVariant');
const Product = require('../models/Product');
const { v4: uuidv4 } = require('uuid');

function resolveIdentity(req) {
  if (req.user) return { type: 'user', id: req.user._id };
  const guestId = req.headers['x-cart-id'] || req.cookies?.cartId;
  return { type: 'guest', id: guestId || null };
}
function summarize(cart) {
  const items = (cart?.items || []).map(i => (typeof i.toObject === 'function') ? i.toObject() : { ...i });
  const itemCount = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const subtotal = items.reduce((s, it) => {
    const finalPrice = Number(it.finalPrice ?? it.discountPrice ?? it.price ?? 0) || 0;
    const qty = Number(it.quantity) || 0;
    return s + (finalPrice * qty);
  }, 0);
  return { subtotal, itemCount };
}
async function getOrCreateCart(identity) {
  if (identity.type === 'user') {
    let cart = await Cart.findOne({ userId: identity.id });
    if (!cart) cart = await Cart.create({ userId: identity.id, items: [] });
    return cart;
  } else {
    // Nếu guestId có -> return hoặc tạo; nếu không có guestId -> KHÔNG auto-create
    if (identity.id) {
      let cart = await Cart.findOne({ guestId: identity.id });
      if (!cart) cart = await Cart.create({ guestId: identity.id, items: [] });
      return cart;
    }
    return null;
  }
}

exports.getCart = async (req, res) => {
  try {
    const identity = resolveIdentity(req);
    let cart = null;
    if (identity.type === 'user') {
      const queryUserId = req.query?.userId || null;
      const targetUserId = (queryUserId && req.user?.role === 'admin') ? queryUserId : identity.id;
      cart = await Cart.findOne({ userId: targetUserId });
      if (!cart) {
        return res.json({
          cartId: undefined,
          guestId: undefined,
          userId: String(targetUserId),
          items: [],
          totals: { subtotal: 0, itemCount: 0 }
        });
      }
    } else {
      const guestId = identity.id;
      if (!guestId) {
        return res.json({
          cartId: undefined,
          guestId: undefined,
          userId: null,
          items: [],
          totals: { subtotal: 0, itemCount: 0 }
        });
      }
      cart = await Cart.findOne({ guestId });
      if (!cart) {
        return res.json({
          cartId: undefined,
          guestId,
          userId: null,
          items: [],
          totals: { subtotal: 0, itemCount: 0 }
        });
      }
    }

    // Normalize items and dedupe by variantId + size
    const raw = (cart.items || []).map(i => (typeof i.toObject === 'function') ? i.toObject() : { ...i });
    const map = new Map();
    for (const it of raw) {
      const variantId = it.variantId ? String(it.variantId) : '';
      const size = it.size || '';
      const color = it.color || '';
      if (!variantId) continue; // skip invalid items (schema expects variantId)
      const key = `${variantId}||${size}||${color}`;
      const qty = Number(it.quantity) || 1;
      const price = Number(it.price) || 0;
      const discountPrice = Number(it.discountPrice) || 0;
      const finalPrice = Number(it.finalPrice) || (discountPrice > 0 ? discountPrice : price);

      if (map.has(key)) {
        const ex = map.get(key);
        ex.quantity += qty;
      } else {
        map.set(key, {
          _id: String(it._id || it.id || ''),
          productId: it.productId ? String(it.productId) : null,
          variantId,
          size,
          color,
          quantity: qty,
          price,
          discountPrice,
          finalPrice,
          name: it.name || '',
          key: it.key || null
        });
      }
    }

    let items = Array.from(map.values());

    // Fetch product & variant details in batch to avoid N+1 queries
    try {
      const productIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
      const variantIds = [...new Set(items.map(i => i.variantId).filter(Boolean))];

      const [products, variants] = await Promise.all([
        productIds.length ? Product.find({ _id: { $in: productIds } }).lean() : Promise.resolve([]),
        variantIds.length ? ProductVariant.find({ _id: { $in: variantIds } }).lean() : Promise.resolve([])
      ]);

      const productMap = new Map(products.map(p => [String(p._id), p]));
      const variantMap = new Map(variants.map(v => [String(v._id), v]));

      // attach product & variant info (and size info) into each item
      items = items.map(it => {
        const prod = it.productId ? productMap.get(String(it.productId)) : null;
        const varDoc = it.variantId ? variantMap.get(String(it.variantId)) : null;
        const sizeInfo = varDoc?.sizes?.find(s => s.size === it.size) || null;

        const productInfo = prod ? {
          _id: String(prod._id),
          name : prod.name || prod.title || '',
          slug: prod.slug || '',
        } : null;

        const variantInfo = varDoc ? {
          _id: String(varDoc._id),
          sku: varDoc.sku || null,
          status: varDoc.status || 'active',
          images : varDoc.images[0] || [],
          sizeInfo: sizeInfo ? {
            size: sizeInfo.size,
            price: Number(sizeInfo.price) || 0,
            discountPrice: Number(sizeInfo.discountPrice) || 0,
            stock: Number(sizeInfo.stock) || 0
          } : null,
          // include other variant-level fields if useful
        } : null;

        return {
          ...it,
          name: productInfo?.name || it.name || '',
          product: productInfo,
          variant: variantInfo,
          color: it.color || null,
          key: it.key || null
        };
      });
    } catch (e) {
      // non-fatal: if product/variant lookup fails, continue returning basic items
      console.warn('getCart - product/variant lookup failed', e.message);
    }

    const subtotal = items.reduce((s, it) => s + (it.finalPrice * it.quantity), 0);
    const itemCount = items.reduce((s, it) => s + it.quantity, 0);
    const names = items.map(i => i.product?.name || i.name || '');

    // Persist cleaned items back to DB if duplicates were present
    if (items.length !== raw.length) {
      // store only the minimal structure back to DB (avoid saving populated product/variant)
      cart.items = items.map(i => ({
        _id: i._id,
        productId: i.productId,
        variantId: i.variantId,
        size: i.size,
        color: i.color || undefined,
        quantity: i.quantity,
        name: i.name || '',
        price: i.price,
        discountPrice: i.discountPrice,
        finalPrice: i.finalPrice,
        key: i.key || undefined
      }));
      cart.updatedAt = new Date();
      try { await cart.save(); } catch (err) { /* non-fatal */ }
    }

    return res.json({
      cartId: cart._id ? String(cart._id) : undefined,
      guestId: cart.guestId || undefined,
      userId: cart.userId ? String(cart.userId) : null,
      items,
      totals: { subtotal, itemCount },
      newGuestId: cart._newGuestId
    });
  } catch (err) {
    console.error('getCart error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.addItem = async (req, res) => {
  try {
    const incoming = req.body || {};
    const productId = incoming.productId || incoming.product_id;
    const variantId = incoming.variantId || incoming.variant_id || null;
    const size = incoming.size || null;
    const qty = Number(incoming.quantity ?? incoming.qty ?? incoming.qty ?? 1) || 1;
    const color = incoming.color || null;
    const key = incoming.key || null;
    const fallbackPrice = Number(incoming.price) || null;
    const name = incoming.name || '';

    if (!productId || !size) {
      return res.status(400).json({ message: 'Missing productId or size' });
    }

    const identity = resolveIdentity(req);
    // nếu guest không có guestId, tạo guest cart LÚC add (không tạo ở GET)
    let cart = await getOrCreateCart(identity);
    if (identity.type === 'guest' && !cart) {
      const gid = uuidv4();
      cart = await Cart.create({ guestId: gid, items: [] });
      cart._newGuestId = gid;
    }
    if (!cart) return res.status(500).json({ message: 'Failed to get or create cart' });

    // Resolve variant: prefer explicit variantId; otherwise try to find by productId + size (+ color/key if present)
    let variant = null;
    if (variantId) {
      variant = await ProductVariant.findById(variantId).lean();
    } else {
      const q = { productId };
      if (color) q.color = color;
      q['sizes.size'] = size;
      variant = await ProductVariant.findOne(q).lean();
      if (!variant) variant = await ProductVariant.findOne({ productId, 'sizes.size': size }).lean();
    }

    let price = fallbackPrice || 0;
    let discountPrice = 0;
    let finalPrice = fallbackPrice || 0;
    if (variant) {
      const sizeObj = (variant.sizes || []).find(s => s.size === size) || null;
      if (!sizeObj) {
        return res.status(400).json({ message: 'Size not found on variant' });
      }
      if ((sizeObj.stock || 0) < qty) return res.status(400).json({ message: 'Not enough stock' });

      price = Number(sizeObj.price) || price || 0;
      discountPrice = Number(sizeObj.discountPrice) || 0;
      finalPrice = (discountPrice > 0) ? discountPrice : price;
    } else {
      if (!fallbackPrice) {
        return res.status(400).json({ message: 'Variant not found and no price provided' });
      }
      price = fallbackPrice;
      finalPrice = fallbackPrice;
      discountPrice = Number(incoming.discountPrice) || 0;
    }
    let existing;
    if (variant && variant._id) {
      existing = cart.items.find(i => String(i.variantId) === String(variant._id) && i.size === size);
    } else if (key) {
      existing = cart.items.find(i => i.key === key && i.size === size);
    } else {
      existing = cart.items.find(i => String(i.productId) === String(productId) && i.size === size);
    }

    // resolve color/colorCode from incoming or variant fallback
    const resolvedColor = color || variant?.color || null;
    const resolvedColorCode = incoming.colorCode || variant?.colorCode || null;

    if (existing) {
      existing.quantity = (existing.quantity || 0) + qty;
      // preserve/update color and image if provided or fallback from variant
      existing.color = resolvedColor || existing.color;
      if (resolvedColorCode) existing.colorCode = resolvedColorCode;
      if (incoming.image) existing.image = incoming.image;
    } else {
      const newItem = {
        productId,
        variantId: variant?._id || null,
        size,
        quantity: qty,
        price,
        discountPrice,
        finalPrice,
        name,
        color: resolvedColor || undefined,
        colorCode: resolvedColorCode || undefined
      };
      if (key) newItem.key = key;
      if (color) newItem.color = color;
      if (incoming.image) newItem.image = incoming.image;
      cart.items.push(newItem);
    }

    cart.updatedAt = new Date();
    await cart.save();

    return res.json({
      cartId: cart._id ? String(cart._id) : undefined,
      guestId: cart.guestId || undefined,
      items: cart.items,
      totals: {
        subtotal: cart.items.reduce((s, it) => s + ((it.finalPrice || 0) * (it.quantity || 1)), 0),
        itemCount: cart.items.reduce((s, it) => s + (it.quantity || 0), 0)
      },
      newGuestId: cart._newGuestId
    });
  } catch (err) {
    console.error('addItem error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.updateItem = async (req, res) => {
  const { itemId } = req.params;
  const { quantity } = req.body;
  if (quantity == null || quantity < 1) return res.status(400).json({ message: 'Invalid quantity' });

  const identity = resolveIdentity(req);
  const cart = await getOrCreateCart(identity);

  // robust lookup whether items are subdocs or plain objects
  const item = (typeof cart.items.id === 'function') ? cart.items.id(itemId) : cart.items.find(i => String(i._id || i.id) === String(itemId));
  if (!item) return res.status(404).json({ message: 'Item not found' });

  // Check stock again
  const variant = await ProductVariant.findById(item.variantId).lean();
  const sizeObj = variant?.sizes?.find(s => s.size === item.size);
  if (!sizeObj) return res.status(400).json({ message: 'Size missing now' });
  if (quantity > sizeObj.stock) return res.status(400).json({ message: 'Exceeds stock' });

  // if it's a plain object we need to write back to array element
  if (typeof item.set === 'function') {
    item.quantity = quantity; // mongoose subdoc
  } else {
    const idx = cart.items.findIndex(i => String(i._id || i.id) === String(itemId));
    if (idx === -1) return res.status(404).json({ message: 'Item not found' });
    cart.items[idx].quantity = quantity;
  }

  cart.updatedAt = new Date();
  await cart.save();
  res.json({ items: cart.items, totals: summarize(cart) });
};

exports.removeItem = async (req, res) => {
  const { itemId } = req.params;
  const identity = resolveIdentity(req);
  const cart = await getOrCreateCart(identity);

  // robust removal whether subdoc or plain object
  if (typeof cart.items.id === 'function') {
    const item = cart.items.id(itemId);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    // if subdoc has remove()
    if (typeof item.remove === 'function') {
      item.remove();
    } else {
      // fallback: splice by index
      const idx = cart.items.findIndex(i => String(i._id || i.id) === String(itemId));
      if (idx === -1) return res.status(404).json({ message: 'Item not found' });
      cart.items.splice(idx, 1);
    }
  } else {
    const idx = cart.items.findIndex(i => String(i._id || i.id) === String(itemId));
    if (idx === -1) return res.status(404).json({ message: 'Item not found' });
    cart.items.splice(idx, 1);
  }

  cart.updatedAt = new Date();
  await cart.save();
  res.json({ items: cart.items, totals: summarize(cart) });
};

exports.clearCart = async (req, res) => {
  const identity = resolveIdentity(req);
  const cart = await getOrCreateCart(identity);
  cart.items = [];
  cart.updatedAt = new Date();
  await cart.save();
  res.json({ items: [], totals: summarize(cart) });
};

exports.mergeCart = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ message: "Auth required" });

    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items array required" });
    }

    const userCart = await getOrCreateCart({ type: "user", id: user._id });

    for (const gItem of items) {
      let incomingVariantId = gItem.variantId || null;
      let productId = gItem.productId || null;
      const size = gItem.size || null;
      let qty = Number(gItem.quantity || gItem.qty || 1) || 1;

      // Resolve variant/product when one is missing:
      let variant;
      if (incomingVariantId) {
        variant = await ProductVariant.findById(incomingVariantId).lean();
        if (variant && !productId) productId = variant.productId;
      } else {
        // try to find variant by productId + size
        if (productId && size) {
          variant = await ProductVariant.findOne({ productId, 'sizes.size': size }).lean();
          if (variant) incomingVariantId = variant._id;
        } else if (productId && !size) {
          // fallback: pick any variant for product if size not provided
          variant = await ProductVariant.findOne({ productId }).lean();
          if (variant) incomingVariantId = variant._id;
        } else if (!productId && size) {
          // try to find a variant that has the requested size
          variant = await ProductVariant.findOne({ 'sizes.size': size }).lean();
          if (variant) {
            incomingVariantId = variant._id;
            productId = variant.productId;
          }
        }
      }

      // If we still don't have a variantId (schema requires it), skip this item
      if (!incomingVariantId) continue;

      // derive pricing/stock from variant + size (if available)
      let price, discountPrice, finalPrice;
      if (variant) {
        const sizeObj = (variant.sizes || []).find(s => s.size === size) || (variant.sizes && variant.sizes[0]);
        if (sizeObj) {
          price = sizeObj.price;
          discountPrice = sizeObj.discountPrice;
          finalPrice = (discountPrice && discountPrice > 0) ? discountPrice : price;
          if ((sizeObj.stock || 0) < qty) qty = Math.max(1, sizeObj.stock || 1);
        }
      }

      // merge by variantId + size
      const ex = userCart.items.find(
        (u) => String(u.variantId) === String(incomingVariantId) && (u.size || "") === (size || "")
      );

      if (ex) {
        ex.quantity = (ex.quantity || 0) + qty;
      } else {
        userCart.items.push({
          productId,
          variantId: incomingVariantId,
          size,
          quantity: qty,
          price,
          discountPrice,
          finalPrice,
          name: gItem.name
        });
      }
    }

    userCart.updatedAt = new Date();
    await userCart.save();

    const totals = summarize(userCart);
    return res.json({ items: userCart.items, totals, merged: true });
  } catch (err) {
    console.error("mergeCart error", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Giảm 1 số lượng của item (nếu về 0 thì xóa item)
exports.decrementItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const identity = resolveIdentity(req);
    const cart = await getOrCreateCart(identity);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });

    // robust lookup whether items are subdocs or plain objects
    const isSubdoc = (typeof cart.items.id === 'function');
    const item = isSubdoc ? cart.items.id(itemId) : cart.items.find(i => String(i._id || i.id) === String(itemId));
    if (!item) return res.status(404).json({ message: 'Item not found' });

    // If quantity missing, assume 1
    const currentQty = Number(item.quantity || 1);

    if (currentQty > 1) {
      // decrement
      if (typeof item.set === 'function') {
        item.quantity = currentQty - 1; // mongoose subdoc
      } else {
        const idx = cart.items.findIndex(i => String(i._id || i.id) === String(itemId));
        if (idx === -1) return res.status(404).json({ message: 'Item not found' });
        cart.items[idx].quantity = currentQty - 1;
      }
    } else {
      // remove item
      if (isSubdoc) {
        const sub = cart.items.id(itemId);
        if (!sub) return res.status(404).json({ message: 'Item not found' });
        if (typeof sub.remove === 'function') sub.remove();
        else {
          const idx = cart.items.findIndex(i => String(i._id || i.id) === String(itemId));
          if (idx !== -1) cart.items.splice(idx, 1);
        }
      } else {
        const idx = cart.items.findIndex(i => String(i._id || i.id) === String(itemId));
        if (idx === -1) return res.status(404).json({ message: 'Item not found' });
        cart.items.splice(idx, 1);
      }
    }

    cart.updatedAt = new Date();
    await cart.save();

    return res.json({ items: cart.items, totals: summarize(cart) });
  } catch (err) {
    console.error('decrementItem error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
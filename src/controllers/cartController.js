const Cart = require('../models/Cart');
const ProductVariant = require('../models/ProductVariant');
const Product = require('../models/Product');
const { v4: uuidv4 } = require('uuid');

function resolveIdentity(req) {
  // Giả sử middleware auth gắn req.user nếu đăng nhập
  if (req.user) return { type: 'user', id: req.user._id };
  const guestId = req.headers['x-cart-id'] || req.cookies?.cartId;
  return { type: 'guest', id: guestId || null };
}

async function getOrCreateCart(identity) {
  if (identity.type === 'user') {
    let cart = await Cart.findOne({ userId: identity.id });
    if (!cart) cart = await Cart.create({ userId: identity.id, items: [] });
    return cart;
  } else {
    let cart = identity.id ? await Cart.findOne({ guestId: identity.id }) : null;
    if (!cart) {
      const gid = identity.id || uuidv4();
      cart = await Cart.create({ guestId: gid, items: [] });
      cart._newGuestId = gid;
    }
    return cart;
  }
}

exports.getCart = async (req, res) => {
  const identity = resolveIdentity(req);
  const cart = await getOrCreateCart(identity);
  res.json({
    cartId: cart.guestId || undefined,
    userId: cart.userId || null,
    items: cart.items,
    totals: summarize(cart)
  });
};

function summarize(cart) {
  const subtotal = cart.items.reduce((s, it) => s + (it.finalPrice * it.quantity), 0);
  return { subtotal, itemCount: cart.items.reduce((s,i)=>s+i.quantity,0) };
}

exports.addItem = async (req, res) => {
  const { productId, variantId, size, quantity = 1 } = req.body;
  if (!productId || !variantId || !size) return res.status(400).json({ message: 'Missing fields' });

  const identity = resolveIdentity(req);
  const cart = await getOrCreateCart(identity);

  // validate variant + size
  const variant = await ProductVariant.findById(variantId).lean();
  if (!variant || String(variant.productId) !== String(productId)) return res.status(404).json({ message: 'Variant not found' });
  const sizeObj = (variant.sizes || []).find(s => s.size === size);
  if (!sizeObj) return res.status(400).json({ message: 'Size not found' });
  if ((sizeObj.stock || 0) < quantity) return res.status(400).json({ message: 'Not enough stock' });

  const finalPrice = (sizeObj.discountPrice && sizeObj.discountPrice > 0) ? sizeObj.discountPrice : sizeObj.price;

  const existing = cart.items.find(i =>
    String(i.variantId) === String(variantId) && i.size === size
  );
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({
      productId,
      variantId,
      size,
      quantity,
      price: sizeObj.price,
      discountPrice: sizeObj.discountPrice,
      finalPrice
    });
  }
  cart.updatedAt = new Date();
  await cart.save();
  res.json({
    cartId: cart.guestId || undefined,
    items: cart.items,
    totals: summarize(cart),
    newGuestId: cart._newGuestId
  });
};

exports.updateItem = async (req, res) => {
  const { itemId } = req.params;
  const { quantity } = req.body;
  if (quantity == null || quantity < 1) return res.status(400).json({ message: 'Invalid quantity' });

  const identity = resolveIdentity(req);
  const cart = await getOrCreateCart(identity);

  const item = cart.items.id(itemId);
  if (!item) return res.status(404).json({ message: 'Item not found' });

  // Check stock again
  const variant = await ProductVariant.findById(item.variantId).lean();
  const sizeObj = variant?.sizes?.find(s => s.size === item.size);
  if (!sizeObj) return res.status(400).json({ message: 'Size missing now' });
  if (quantity > sizeObj.stock) return res.status(400).json({ message: 'Exceeds stock' });

  item.quantity = quantity;
  cart.updatedAt = new Date();
  await cart.save();
  res.json({ items: cart.items, totals: summarize(cart) });
};

exports.removeItem = async (req, res) => {
  const { itemId } = req.params;
  const identity = resolveIdentity(req);
  const cart = await getOrCreateCart(identity);
  const item = cart.items.id(itemId);
  if (!item) return res.status(404).json({ message: 'Item not found' });
  item.remove();
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
  // Call sau login: body { guestCartId }
  const user = req.user;
  if (!user) return res.status(401).json({ message: 'Auth required' });
  const { guestCartId } = req.body;
  if (!guestCartId) return res.status(400).json({ message: 'guestCartId required' });

  const guestCart = await Cart.findOne({ guestId: guestCartId });
  const userCart = await getOrCreateCart({ type: 'user', id: user._id });

  if (guestCart && guestCart.items.length) {
    guestCart.items.forEach(gItem => {
      const ex = userCart.items.find(u =>
        String(u.variantId) === String(gItem.variantId) && u.size === gItem.size
      );
      if (ex) {
        ex.quantity += gItem.quantity;
      } else {
        userCart.items.push(gItem.toObject());
      }
    });
    await guestCart.deleteOne();
  }

  userCart.updatedAt = new Date();
  await userCart.save();
  res.json({ items: userCart.items, totals: summarize(userCart) });
};
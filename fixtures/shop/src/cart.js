// Tiny cart module used by the demo shop.
// SYNTHETIC DEMO FIXTURE: contains an intentional bug for the RedGreen demo.

export const COUPONS = {
  SAVE10: 0.10,
  SAVE20: 0.20,
};

export function createCart() {
  return { items: [], coupon: null, discount: 0 };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function subtotal(cart) {
  return round2(cart.items.reduce((sum, it) => sum + it.price * it.qty, 0));
}

export function addItem(cart, { id, name, price }, qty = 1) {
  if (!Number.isFinite(price) || price < 0) throw new Error('Invalid price');
  const existing = cart.items.find((it) => it.id === id);
  if (existing) existing.qty += qty;
  else cart.items.push({ id, name, price, qty });
  return cart;
}

export function setQuantity(cart, id, qty) {
  if (!Number.isInteger(qty) || qty < 0) throw new Error('Invalid quantity');
  const item = cart.items.find((it) => it.id === id);
  if (!item) throw new Error('Item not in cart');
  if (qty === 0) cart.items = cart.items.filter((it) => it.id !== id);
  else item.qty = qty;
  return cart;
}

export function applyCoupon(cart, code) {
  const pct = COUPONS[code];
  if (pct === undefined) throw new Error('Invalid coupon');
  cart.coupon = code;
  cart.discount = round2(subtotal(cart) * pct);
  return cart;
}

export function total(cart) {
  return round2(Math.max(0, subtotal(cart) - cart.discount));
}

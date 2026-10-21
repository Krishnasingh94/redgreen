// Existing test suite for the demo shop. These all pass, yet the bug ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, setQuantity, applyCoupon, subtotal, total } from '../src/cart.js';

const HEADPHONES = { id: 'hp', name: 'Headphones', price: 50 };
const CABLE = { id: 'cb', name: 'USB-C Cable', price: 12.5 };

test('subtotal sums price x qty', () => {
  const cart = createCart();
  addItem(cart, HEADPHONES, 2);
  addItem(cart, CABLE, 1);
  assert.equal(subtotal(cart), 112.5);
});

test('adding an existing item increases quantity', () => {
  const cart = createCart();
  addItem(cart, HEADPHONES);
  addItem(cart, HEADPHONES);
  assert.equal(cart.items[0].qty, 2);
});

test('coupon applies percentage discount', () => {
  const cart = createCart();
  addItem(cart, HEADPHONES, 2);
  applyCoupon(cart, 'SAVE10');
  assert.equal(total(cart), 90);
});

test('invalid coupon throws', () => {
  const cart = createCart();
  assert.throws(() => applyCoupon(cart, 'FREE100'), /Invalid coupon/);
});

test('setting quantity to 0 removes the item', () => {
  const cart = createCart();
  addItem(cart, HEADPHONES, 1);
  setQuantity(cart, 'hp', 0);
  assert.equal(cart.items.length, 0);
});

---
id: order-modifications
title: Order Changes and Cancellations
always: false
weight: 55
signals: [cancel my order, change my order, add to my order, remove from order, "wrong address", "change address", "change shipping", "wrong item", "ordered the wrong", edit order, order]
fingerprint: Edit/cancel windows: free before dispatch, mostly impossible after; wrong-item swap path.
---

Order changes:

- Before dispatch: the reader can change the shipping address, payment method,
  or cancel the order entirely, free, at Account → Orders → the order. Same-day
  changes are common; the dispatch cutoff is 14:00 CET.
- After dispatch: the order is the courier's. We cannot edit the address
  (redirect depends on the courier; see shipping policy), and we cannot cancel.
  The path is: receive it, then use the 30-day return policy.
- Adding an item to an existing order is not possible after checkout; the
  reader places a second order and the shipping is combined automatically when
  both would arrive together (or the second order ships free when the first has
  not shipped yet — confirm before promising).
- Removing an item: only before dispatch, only the item that has not entered
  the packing line; the refund for the removed item follows the refund policy.
- Wrong item ordered (the reader picked the wrong color, the wrong model):
  this is not an error on our side — the return path applies, 30 days, prepaid
  label. The reader does not pay for the mistake twice; we also match the
  original sale price on the reorder of the correct item if the price moved in
  the meantime.
- An item that never shipped after dispatch confirmation: treat as a dispatch
  error, escalate to the fulfillment desk with the order number, and tell the
  reader the updated promise in concrete terms.

Always restate the exact order being changed (number, item, price) before
making any change, so there is no ambiguity about what was altered.

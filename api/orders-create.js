import shopify from "../lib/shopify-client.js";
import {
  adjustInventory,
  getRipMasterSku,
  findVariantBySku,
  getInventoryLevel
} from "../lib/inventory-helpers.js";

export default async function handler(req, res) {
  // Shopify will always POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const order = req.body;
  let isRipShip = false;

  try {
    for (const line of order.line_items) {
      const productId = line.product_id;
      const variantId = line.variant_id;
      const quantity = line.quantity;

      // 1. Detect Rip & Ship metafield
      const masterSku = await getRipMasterSku(productId);
      if (!masterSku) continue;

      isRipShip = true;

      // 2. Get Rip & Ship inventory_item_id
      const variantRes = await shopify.get(`/variants/${variantId}.json`);
      const ripInventoryItemId = variantRes.data.variant.inventory_item_id;

      // Undo deduction
      await adjustInventory(ripInventoryItemId, quantity);

      // 3. Find master variant by SKU
      const masterVariant = await findVariantBySku(masterSku);
      if (!masterVariant) continue;

      const masterInventoryItemId = masterVariant.inventory_item_id;

      // 4. Check available inventory (prevent negative)
      const available = await getInventoryLevel(masterInventoryItemId);
      const safeAdjustment = quantity > available ? -available : -quantity;

      // Deduct from master
      await adjustInventory(masterInventoryItemId, safeAdjustment);
    }

    // Tag the order
    if (isRipShip) {
      const currentTags = order.tags ?? "";
      const tagsSet = new Set(
        currentTags.split(",").map((t) => t.trim()).filter(Boolean)
      );
      tagsSet.add("ripship");

      await shopify.put(`/orders/${order.id}.json`, {
        order: {
          id: order.id,
          tags: [...tagsSet].join(", "),
        },
      });
    }

    return res.status(200).json({ status: "OK" });
  } catch (err) {
    console.error("Webhook Error:", err.response?.data || err);
    return res.status(500).json({ error: "Internal error" });
  }
}

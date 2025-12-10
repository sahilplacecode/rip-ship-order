// server.js
import express from "express";
import crypto from "crypto";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// Shopify credentials
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. "your-store.myshopify.com"
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // from webhook config (HMAC key)

// Main location ID (hardcode or load from env)
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;

// Raw body for HMAC validation
app.use(
  "/webhooks/orders/create",
  bodyParser.raw({ type: "application/json" })
);

// HMAC validation helper
function verifyShopifyWebhook(req) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// Helper: call Shopify REST
async function shopifyRequest(path, options = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2025-01${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Shopify API error:", res.status, text);
    throw new Error(`Shopify API error: ${res.status}`);
  }
  return res.json();
}

// Webhook handler
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.error("Invalid HMAC for order webhook");
      return res.status(401).send("Invalid HMAC");
    }

    const order = JSON.parse(req.body.toString("utf8"));
    console.log("New order:", order.id);

    const ripLineItems = [];

    for (const line of order.line_items || []) {
      const variantId = line.variant_id;
      const quantity = line.quantity;

      if (!variantId || !quantity) continue;

      // 1. Get metafields for this variant
      const metafieldsResponse = await shopifyRequest(
        `/variants/${variantId}/metafields.json`,
        { method: "GET" }
      );

      const metafields = metafieldsResponse.metafields || [];
      const ripMasterMeta = metafields.find(
        (m) => m.namespace === "rip" && m.key === "master_sku"
      );

      if (!ripMasterMeta || !ripMasterMeta.value) {
        continue; // Not a Rip & Ship line item
      }

      const masterSku = ripMasterMeta.value;
      ripLineItems.push({ line, masterSku });
    }

    // If no Rip & Ship items, just respond OK
    if (ripLineItems.length === 0) {
      return res.status(200).send("No rip items");
    }

    // Process each Rip & Ship line item
    for (const item of ripLineItems) {
      const { line, masterSku } = item;
      const quantity = line.quantity;
      const ripVariantId = line.variant_id;

      // 2. Find Rip & Ship variant details (to get inventory_item_id)
      const ripVariantRes = await shopifyRequest(
        `/variants/${ripVariantId}.json`,
        { method: "GET" }
      );
      const ripVariant = ripVariantRes.variant;
      const ripInventoryItemId = ripVariant.inventory_item_id;

      // 3. Find master variant by SKU
      const masterVariantsRes = await shopifyRequest(
        `/variants.json?sku=${encodeURIComponent(masterSku)}`,
        { method: "GET" }
      );
      const masterVariant = masterVariantsRes.variants[0];

      if (!masterVariant) {
        console.error("Master variant not found for sku:", masterSku);
        continue;
      }

      const masterInventoryItemId = masterVariant.inventory_item_id;

      // 4. Undo deduction for Rip & Ship SKU (+quantity)
      await shopifyRequest(`/inventory_levels/adjust.json`, {
        method: "POST",
        body: JSON.stringify({
          location_id: Number(LOCATION_ID),
          inventory_item_id: ripInventoryItemId,
          available_adjustment: quantity, // add back
        }),
      });

      // 5. Deduct from master SKU (-quantity)
      await shopifyRequest(`/inventory_levels/adjust.json`, {
        method: "POST",
        body: JSON.stringify({
          location_id: Number(LOCATION_ID),
          inventory_item_id: masterInventoryItemId,
          available_adjustment: -quantity, // subtract
        }),
      });

      console.log(
        `Adjusted inventory: +${quantity} to rip item ${ripInventoryItemId}, -${quantity} from master ${masterInventoryItemId}`
      );
    }

    // 6. Tag the order as RIP & SHIP
    const existingTags = order.tags || "";
    const tagsArray = existingTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (!tagsArray.includes("RIP & SHIP")) {
      tagsArray.push("RIP & SHIP");
    }

    await shopifyRequest(`/orders/${order.id}.json`, {
      method: "PUT",
      body: JSON.stringify({
        order: {
          id: order.id,
          tags: tagsArray.join(", "),
        },
      }),
    });

    res.status(200).send("Processed rip & ship inventory");
  } catch (err) {
    console.error("Error in webhook handler:", err);
    // Respond 200 so Shopify doesn't retry infinitely, OR 500 if you want retries
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`Rip & Ship app listening on port ${PORT}`);
});

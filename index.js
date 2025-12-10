// index.js
import express from "express";
import crypto from "crypto";
import getRawBody from "raw-body";

const app = express();
const port = process.env.PORT || 3000;

// We will handle raw body ourselves for HMAC
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const rawBody = await getRawBody(req);
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    const verified = verifyShopifyHmac(rawBody, hmacHeader);
    if (!verified) {
      console.error("Invalid HMAC - ignoring webhook");
      return res.status(401).send("Invalid HMAC");
    }

    const order = JSON.parse(rawBody.toString("utf8"));
    console.log("Received order", order.id);

    await handleRipShipLogic(order);

    // Respond quickly so Shopify is happy
    res.status(200).send("ok");
  } catch (err) {
    console.error("Error handling webhook:", err);
    // Still respond 200 to avoid retries if you want,
    // but 500 is technically more correct
    res.status(500).send("error");
  }
});

// Fallback route
app.get("/", (req, res) => {
  res.send("Rip & Ship webhook app running");
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

function verifyShopifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret || !hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  // Shopify may send header in lowercase/uppercase, but we already grabbed it normal
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

async function handleRipShipLogic(order) {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const locationId = process.env.RIPSHIP_LOCATION_ID;

  if (!storeDomain || !token || !locationId) {
    throw new Error("Missing env variables");
  }

  const lineItems = order.line_items || [];

  let hasRipShip = false;

  for (const lineItem of lineItems) {
    const productId = lineItem.product_id;
    const variantId = lineItem.variant_id;
    const quantity = lineItem.quantity;

    if (!productId || !variantId || !quantity) continue;

    // 1) Read the rip.master_sku metafield from the product
    const masterSku = await getMasterSkuForProduct(storeDomain, token, productId);
    if (!masterSku) {
      continue; // not a rip & ship product
    }

    hasRipShip = true;

    console.log(
      `Line item ${lineItem.id} is rip & ship. master_sku=${masterSku}, qty=${quantity}`
    );

    // 2) Get inventory_item_id for the RIP variant
    const ripVariant = await getVariantById(storeDomain, token, variantId);
    const ripInventoryItemId = ripVariant?.inventory_item_id;
    if (!ripInventoryItemId) {
      console.warn("No inventory_item_id for rip variant", variantId);
      continue;
    }

    // 3) Get master variant by masterSku → inventory_item_id
    const masterVariant = await getVariantBySku(storeDomain, token, masterSku);
    if (!masterVariant) {
      console.warn("No variant found for master SKU", masterSku);
      continue;
    }
    const masterInventoryItemId = masterVariant.inventory_item_id;

    // 4) Restore quantity to RIP SKU (undo Shopify auto-deduction)
    await adjustInventoryLevel({
      storeDomain,
      token,
      inventoryItemId: ripInventoryItemId,
      locationId,
      adjustment: quantity // +qty
    });

    // 5) Deduct from master SKU, but NEVER go below 0
    const masterAvailable = await getAvailableInventory({
      storeDomain,
      token,
      inventoryItemId: masterInventoryItemId,
      locationId
    });

    const adjustQty = Math.min(quantity, masterAvailable);
    if (adjustQty <= 0) {
      console.warn(
        `Master product has no stock (available=${masterAvailable}), not deducting.`
      );
      // Optional: tag order or add note. For now just skip deduction.
    } else {
      await adjustInventoryLevel({
        storeDomain,
        token,
        inventoryItemId: masterInventoryItemId,
        locationId,
        adjustment: -adjustQty // subtract
      });

      console.log(
        `Deducted ${adjustQty} from master inventory. (requested=${quantity}, available=${masterAvailable})`
      );
    }
  }

  // 6) If any line item was rip & ship → tag order
  if (hasRipShip) {
    await tagOrderRipShip(storeDomain, token, order);
  }
}

// --- Helper functions using REST Admin API ---

async function shopifyFetch(path, options = {}) {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  const url = `https://${storeDomain}/admin/api/2025-01${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Shopify API error:", res.status, text);
    throw new Error(`Shopify API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function getMasterSkuForProduct(storeDomain, token, productId) {
  const data = await shopifyFetch(
    `/products/${productId}/metafields.json?namespace=rip&key=master_sku`
  );

  const metafields = data.metafields || [];
  if (!metafields.length) return null;

  return metafields[0].value;
}

async function getVariantById(storeDomain, token, variantId) {
  const data = await shopifyFetch(`/variants/${variantId}.json`);
  return data.variant;
}

async function getVariantBySku(storeDomain, token, sku) {
  // REST supports ?sku= query on /variants.json
  const data = await shopifyFetch(`/variants.json?sku=${encodeURIComponent(sku)}`);
  const variants = data.variants || [];
  return variants[0] || null;
}

async function getAvailableInventory({ storeDomain, token, inventoryItemId, locationId }) {
  const data = await shopifyFetch(
    `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationId}`
  );

  const levels = data.inventory_levels || [];
  if (!levels.length) return 0;

  const level = levels[0];
  // "available" can be null if item not tracked
  return level.available ?? 0;
}

async function adjustInventoryLevel({
  storeDomain,
  token,
  inventoryItemId,
  locationId,
  adjustment
}) {
  const body = {
    inventory_item_id: inventoryItemId,
    location_id: Number(locationId),
    available_adjustment: adjustment
  };

  await shopifyFetch(`/inventory_levels/adjust.json`, {
    method: "POST",
    body: JSON.stringify(body)
  });

  console.log(
    `Adjusted inventory_item_id=${inventoryItemId} by ${adjustment} at location=${locationId}`
  );
}

async function tagOrderRipShip(storeDomain, token, order) {
  const id = order.id;
  const existingTags = (order.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  if (!existingTags.includes("RIP & SHIP")) {
    existingTags.push("RIP & SHIP");
  }

  const body = {
    order: {
      id,
      tags: existingTags.join(", ")
    }
  };

  await shopifyFetch(`/orders/${id}.json`, {
    method: "PUT",
    body: JSON.stringify(body)
  });

  console.log(`Order ${id} tagged as RIP & SHIP`);
}

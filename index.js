// index.js
import express from "express";
import crypto from "crypto";
import getRawBody from "raw-body";

const app = express();
const port = process.env.PORT || 3000;

/* ─────────────────────────────────────────────
   WEBHOOK ROUTE — receives Shopify order.create
───────────────────────────────────────────── */
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const rawBody = await getRawBody(req);
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    // 1️⃣ Verify webhook
    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      console.error("❌ Invalid Shopify HMAC — webhook rejected");
      return res.status(401).send("Invalid webhook");
    }

    console.log("✅ Shopify Webhook Verified");

    // 2️⃣ Parse order JSON
    const order = JSON.parse(rawBody.toString("utf8"));
    console.log("📦 Received order:", order.id);

    // 3️⃣ Run your Rip & Ship logic
    await handleRipShipLogic(order);

    res.status(200).send("OK");
  } catch (err) {
    console.error("💥 Webhook error:", err);
    res.status(500).send("Server error");
  }
});

app.get("/", (req, res) => {
  res.send("Rip & Ship webhook running.");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

/* ─────────────────────────────────────────────
   HMAC VERIFICATION — uses API SECRET KEY
───────────────────────────────────────────── */
function verifyShopifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_API_SECRET_KEY;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}

/* ─────────────────────────────────────────────
   CORE RIP & SHIP LOGIC
───────────────────────────────────────────── */
async function handleRipShipLogic(order) {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const locationId = process.env.RIPSHIP_LOCATION_ID;

  const lineItems = order.line_items || [];
  let isRipShipOrder = false;

  for (const item of lineItems) {
    const productId = item.product_id;
    const variantId = item.variant_id;
    const quantity = item.quantity;

    if (!productId || !variantId) continue;

    // 1️⃣ Read metafield rip.master_sku
    const masterSku = await getMasterSku(productId);
    if (!masterSku) continue; // skip non-rip products

    console.log(`🔍 Rip & Ship detected → master SKU = ${masterSku}`);
    isRipShipOrder = true;

    // 2️⃣ Get inventory_item_id of the RIP variant
    const ripVariant = await getVariantById(variantId);
    const ripInvId = ripVariant.inventory_item_id;

    // 3️⃣ Find master variant by SKU → get its inventory_item_id
    const masterVariant = await getVariantBySku(masterSku);
    const masterInvId = masterVariant.inventory_item_id;

    // 4️⃣ Restore quantity to RIP product (undo Shopify deduction)
    await adjustInventory(ripInvId, locationId, quantity);

    // 5️⃣ Deduct from master product, but never below zero
    const masterAvailable = await getAvailable(masterInvId, locationId);
    const subtractQty = Math.min(quantity, masterAvailable);

    if (subtractQty > 0) {
      await adjustInventory(masterInvId, locationId, -subtractQty);
      console.log(`✔ Deducted ${subtractQty} from master stock`);
    } else {
      console.log("⚠ Master product is out of stock — cannot deduct");
    }
  }

  // 6️⃣ Add "RIP & SHIP" tag
  if (isRipShipOrder) {
    await tagOrder(order.id, "RIP & SHIP");
    console.log("🏷 Order tagged as RIP & SHIP");
  }
}

/* ─────────────────────────────────────────────
   SHOPIFY REST HELPERS
───────────────────────────────────────────── */
async function shopify(path, method = "GET", body = null) {
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10${path}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
      },
      body: body ? JSON.stringify(body) : null
    }
  );

  const data = await res.json();

  if (!res.ok) {
    console.error("❌ Shopify API Error:", data);
    throw new Error(JSON.stringify(data));
  }

  return data;
}

async function getMasterSku(productId) {
  const data = await shopify(
    `/products/${productId}/metafields.json?namespace=rip&key=master_sku`
  );

  return data.metafields?.[0]?.value || null;
}

async function getVariantById(id) {
  const data = await shopify(`/variants/${id}.json`);
  return data.variant;
}

async function getVariantBySku(sku) {
  const data = await shopify(`/variants.json?sku=${encodeURIComponent(sku)}`);
  return data.variants?.[0];
}

async function getAvailable(invId, locId) {
  const data = await shopify(
    `/inventory_levels.json?inventory_item_ids=${invId}&location_ids=${locId}`
  );

  return data.inventory_levels?.[0]?.available || 0;
}

async function adjustInventory(invId, locId, amount) {
  await shopify(`/inventory_levels/adjust.json`, "POST", {
    inventory_item_id: invId,
    location_id: Number(locId),
    available_adjustment: amount
  });

  console.log(`🔧 Adjusted inventory_item_id ${invId} by ${amount}`);
}

async function tagOrder(orderId, tag) {
  await shopify(`/orders/${orderId}.json`, "PUT", {
    order: { id: orderId, tags: tag }
  });
}

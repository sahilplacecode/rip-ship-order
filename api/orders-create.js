import crypto from "crypto";
import shopify from "../../lib/shopify-client.js";
import {
  adjustInventory,
  getRipMasterSku,
  findVariantBySku,
  getInventoryLevel
} from "../../lib/inventory-helpers.js";

// ❗ CRITICAL: Disable automatic body parsing so we can verify raw HMAC
export const config = {
  api: {
    bodyParser: false,
  },
};

// Read raw request body
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Verify Shopify HMAC using your real secret
function verifyShopifyHmac(rawBody, hmacHeader) {
  const secret = "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"; // <-- your secret

  const generatedHash = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(generatedHash),
    Buffer.from(hmacHeader)
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1️⃣ Get raw body BEFORE parsing
    const rawBody = await getRawBody(req);

    // 2️⃣ Verify HMAC
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      console.error("❌ Invalid Shopify HMAC — webhook rejected");
      return res.status(401).send("Invalid HMAC");
    }

    console.log("✅ Shopify Webhook Verified");

    // 3️⃣ Parse order JSON AFTER HMAC passes
    const order = JSON.parse(rawBody.toString("utf8"));
    console.log("📦 Order received:", order.id);

    let isRipShip = false;

    // 4️⃣ Rip & Ship inventory logic
    for (const line of order.line_items) {
      const productId = line.product_id;
      const variantId = line.variant_id;
      const quantity = line.quantity;

      const masterSku = await getRipMasterSku(productId);
      if (!masterSku) continue;

      isRipShip = true;

      // RIP variant → restore deducted inventory
      const variantRes = await shopify.get(`/variants/${variantId}.json`);
      const ripInventoryItemId = variantRes.data.variant.inventory_item_id;

      await adjustInventory(ripInventoryItemId, quantity);

      // Master variant by SKU
      const masterVariant = await findVariantBySku(masterSku);
      if (!masterVariant) continue;

      const masterInventoryItemId = masterVariant.inventory_item_id;

      // Prevent negative stock
      const available = await getInventoryLevel(masterInventoryItemId);
      const safeAdjustment = quantity > available ? -available : -quantity;

      await adjustInventory(masterInventoryItemId, safeAdjustment);
    }

    // 5️⃣ Add order tag
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
    return res.status(500).json({ error: "Internal server error" });
  }
}

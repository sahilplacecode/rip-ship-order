import shopify from "./shopify-client.js";

const LOCATION_ID = process.env.LOCATION_ID;

export async function adjustInventory(itemId, adjustment) {
  return shopify.post("/inventory_levels/adjust.json", {
    location_id: LOCATION_ID,
    inventory_item_id: itemId,
    available_adjustment: adjustment,
  });
}

export async function getRipMasterSku(productId) {
  const res = await shopify.get(
    `/products/${productId}/metafields.json?namespace=rip&key=master_sku`
  );
  return res.data.metafields[0]?.value || null;
}

export async function findVariantBySku(sku) {
  const res = await shopify.get(`/variants.json?sku=${sku}`);
  return res.data.variants[0] || null;
}

export async function getInventoryLevel(itemId) {
  const res = await shopify.get("/inventory_levels.json", {
    params: {
      inventory_item_ids: itemId,
      location_ids: LOCATION_ID,
    },
  });

  return res.data.inventory_levels[0]?.available ?? null;
}

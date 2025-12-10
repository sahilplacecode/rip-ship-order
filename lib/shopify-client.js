import axios from "axios";

const shopify = axios.create({
  baseURL: `https://${process.env.SHOP}/admin/api/2024-04`,
  headers: {
    "X-Shopify-Access-Token": process.env.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,
    "Content-Type": "application/json",
  },
});

export default shopify;

import axios from "axios";

const shopify = axios.create({
  baseURL: `https://${process.env.SHOP}/admin/api/2024-04`,
  headers: {
    "X-Shopify-Access-Token": process.env.ADMIN_TOKEN,
    "Content-Type": "application/json",
  },
});

export default shopify;

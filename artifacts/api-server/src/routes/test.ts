import { Router, type IRouter } from "express";
import axios from "axios";

const router: IRouter = Router();

router.get("/test/:ean", async (req, res) => {
  const { ean } = req.params;
  const url = `https://world.openfoodfacts.org/api/v2/product/${ean}.json`;
  const result: Record<string, unknown> = {
    ean,
    url,
    timestamp: new Date().toISOString(),
    steps: [] as string[],
  };
  const steps = result.steps as string[];

  steps.push(`Fetching: ${url}`);

  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "iPremiumScan-Debug/1.0" },
    });

    steps.push(`HTTP status: ${resp.status}`);
    steps.push(`Content-Type: ${resp.headers["content-type"]}`);

    const data = resp.data as { status?: number; product?: { product_name?: string; brands?: string; categories?: string } };
    result.httpStatus = resp.status;
    result.offStatus = data.status;
    result.hasProduct = !!data.product;

    if (data.product) {
      result.productName = data.product.product_name || null;
      result.brands = data.product.brands || null;
      result.categories = data.product.categories || null;
      steps.push(`Product found! Name: "${data.product.product_name}"`);
    } else {
      steps.push("No product object in response");
      result.rawKeys = Object.keys(data);
    }
  } catch (err: unknown) {
    const e = err as {
      code?: string;
      message?: string;
      response?: { status?: number; data?: unknown; headers?: Record<string, string> };
    };
    steps.push(`ERROR: ${e.message}`);
    result.errorCode = e.code;
    result.errorMessage = e.message;
    if (e.response) {
      result.httpStatus = e.response.status;
      result.responseBody = e.response.data;
    }
  }

  // Also do a quick connectivity check
  try {
    steps.push("Connectivity check: fetching https://1.1.1.1/...");
    const check = await axios.get("https://1.1.1.1/", { timeout: 3000 });
    steps.push(`Connectivity OK (status ${check.status})`);
  } catch (err: unknown) {
    const e = err as { message?: string };
    steps.push(`Connectivity FAILED: ${e.message}`);
  }

  res.json(result);
});

export default router;

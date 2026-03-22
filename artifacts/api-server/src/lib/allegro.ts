import axios from "axios";
import { logger } from "./logger";
import { getUserToken, setUserToken } from "./allegro-auth";

const ALLEGRO_CLIENT_ID = process.env.ALLEGRO_CLIENT_ID;
const ALLEGRO_CLIENT_SECRET = process.env.ALLEGRO_CLIENT_SECRET;
const ALLEGRO_BASE_URL = "https://api.allegro.pl";

// Client Credentials token (limited scopes: offers + settings only)
let ccToken: string | null = null;
let ccTokenExpiry: number = 0;

export async function getClientCredentialsToken(): Promise<string> {
  if (ccToken && Date.now() < ccTokenExpiry) {
    return ccToken;
  }

  if (!ALLEGRO_CLIENT_ID || !ALLEGRO_CLIENT_SECRET) {
    throw new Error("ALLEGRO_CLIENT_ID and ALLEGRO_CLIENT_SECRET must be set");
  }

  const credentials = Buffer.from(
    `${ALLEGRO_CLIENT_ID}:${ALLEGRO_CLIENT_SECRET}`
  ).toString("base64");

  const response = await axios.post(
    "https://allegro.pl/auth/oauth/token?grant_type=client_credentials",
    {},
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10000,
    }
  );

  ccToken = response.data.access_token;
  ccTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

  logger.info("Allegro client credentials token acquired");
  return ccToken as string;
}

// Legacy export so existing code keeps compiling
export const getAllegroToken = getClientCredentialsToken;

/**
 * Search Allegro product catalog by EAN.
 * Requires a USER token (Device Flow) — client credentials return 403.
 * Tries multiple query parameter formats.
 */
export async function searchCatalogByEan(ean: string) {
  const token = await getUserToken();

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.allegro.public.v1+json",
  };

  const attempts = [
    { phrase: ean, language: "pl-PL" },
    { "filters.EAN": ean, language: "pl-PL" },
    { "filters.GTIN": ean, language: "pl-PL" },
  ];

  for (const params of attempts) {
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    const url = `${ALLEGRO_BASE_URL}/sale/products?${queryString}`;
    logger.info({ url }, "Searching Allegro catalog");

    try {
      const response = await axios.get(url, { headers, timeout: 10000 });
      const data = response.data as { products?: unknown[]; totalCount?: number };
      if (data.products && data.products.length > 0) {
        logger.info({ params, count: data.products.length }, "Allegro catalog hit");
        return response.data;
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number } };
      if (e.response?.status === 403) {
        throw err; // bubble up so caller can fall back to lookup
      }
      // On other errors, try next param variant
    }
  }

  return { products: [], totalCount: 0 };
}

export async function getCategoryName(categoryId: string): Promise<string> {
  let token: string;
  try {
    token = await getUserToken();
  } catch {
    token = await getClientCredentialsToken();
  }
  const response = await axios.get(`${ALLEGRO_BASE_URL}/sale/categories/${categoryId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.allegro.public.v1+json",
    },
    timeout: 6000,
  });
  return (response.data as { name?: string }).name ?? "";
}

export async function getCategoryParameters(categoryId: string) {
  // This endpoint requires a user-level token; fall back to CC if none available
  let token: string;
  try {
    token = await getUserToken();
  } catch {
    token = await getClientCredentialsToken();
  }

  const response = await axios.get(
    `${ALLEGRO_BASE_URL}/sale/categories/${categoryId}/parameters`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.allegro.public.v1+json",
      },
      timeout: 10000,
    }
  );

  return response.data;
}

// ── Fixed defaults — resolved once at startup and cached ─────────────────────

interface FixedDefaults {
  shippingRateId: string | null;
  returnPolicyId: string | null;
  impliedWarrantyId: string | null;
}

const fixedDefaults: FixedDefaults = {
  shippingRateId: null,
  returnPolicyId: null,
  impliedWarrantyId: null,
};

function pickById<T extends { id: string; name: string }>(
  items: T[],
  nameContains: string,
  label: string
): string | null {
  const match = items.find((x) => x.name.toUpperCase() === nameContains.toUpperCase());
  if (match) {
    logger.info({ id: match.id, name: match.name }, `Fixed default resolved: ${label}`);
    return match.id;
  }
  const fallback = items[0] ?? null;
  if (fallback) {
    logger.warn(
      { searched: nameContains, fallbackId: fallback.id, fallbackName: fallback.name },
      `Fixed default "${label}" not found by name — using first available as fallback`
    );
    return fallback.id;
  }
  logger.warn({ searched: nameContains }, `Fixed default "${label}" not found and no fallback available`);
  return null;
}

export async function loadFixedDefaults(): Promise<void> {
  try {
    const token = await getUserToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.allegro.public.v1+json",
    };

    const [shippingRes, returnRes, warrantyRes] = await Promise.allSettled([
      axios.get(`${ALLEGRO_BASE_URL}/sale/shipping-rates`, { headers, timeout: 10000 }),
      axios.get(`${ALLEGRO_BASE_URL}/after-sales-service-conditions/return-policies`, { headers, timeout: 10000 }),
      axios.get(`${ALLEGRO_BASE_URL}/after-sales-service-conditions/implied-warranties`, { headers, timeout: 10000 }),
    ]);

    const rates = shippingRes.status === "fulfilled"
      ? ((shippingRes.value.data as { shippingRates?: { id: string; name: string }[] }).shippingRates || [])
      : [];
    const policies = returnRes.status === "fulfilled"
      ? ((returnRes.value.data as { returnPolicies?: { id: string; name: string }[] }).returnPolicies || [])
      : [];
    const warranties = warrantyRes.status === "fulfilled"
      ? ((warrantyRes.value.data as { impliedWarranties?: { id: string; name: string }[] }).impliedWarranties || [])
      : [];

    fixedDefaults.shippingRateId = pickById(rates, "DOSTAWA", "shippingRate");
    fixedDefaults.returnPolicyId = pickById(policies, "ZWROT", "returnPolicy");
    fixedDefaults.impliedWarrantyId = pickById(warranties, "REKLAMACJA", "impliedWarranty");

    logger.info(
      { fixedDefaults },
      "Fixed offer defaults loaded and cached"
    );
  } catch (err) {
    logger.error({ err }, "Failed to load fixed offer defaults — will retry on first offer creation");
  }
}

export async function uploadImageToAllegro(imageUrl: string): Promise<string | null> {
  try {
    const token = await getUserToken();
    const resp = await axios.post(
      "https://upload.allegro.pl/sale/images",
      { url: imageUrl },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.allegro.public.v1+json",
        },
        timeout: 30000,
      }
    );
    const allegroUrl = (resp.data as { url?: string }).url || null;
    logger.info({ imageUrl, allegroUrl }, "Image uploaded to Allegro");
    return allegroUrl;
  } catch (err: unknown) {
    logger.warn({ err, imageUrl }, "Failed to upload image URL to Allegro");
    return null;
  }
}

export async function uploadImageBinaryToAllegro(
  data: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    const token = await getUserToken();
    const resp = await axios.post(
      "https://upload.allegro.pl/sale/images",
      data,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
          Accept: "application/vnd.allegro.public.v1+json",
        },
        timeout: 30000,
      }
    );
    const allegroUrl = (resp.data as { url?: string }).url || null;
    logger.info({ allegroUrl }, "Binary image uploaded to Allegro");
    return allegroUrl;
  } catch (err: unknown) {
    logger.warn({ err }, "Failed to upload binary image to Allegro");
    return null;
  }
}

export async function createAllegroOffer(payload: {
  productId?: string | null;
  categoryId: string;
  productName: string;
  parameters: Array<{
    id: string;
    values?: string[];
    valuesIds?: string[];
  }>;
  productParamIds?: string[];
  imageUrl?: string | null;
}) {
  const token = await getUserToken();

  // If fixedDefaults were not loaded yet (e.g. no user token at startup), try now
  if (!fixedDefaults.shippingRateId && !fixedDefaults.returnPolicyId && !fixedDefaults.impliedWarrantyId) {
    await loadFixedDefaults();
  }

  // Split parameters into product-level and offer-level
  const productParamSet = new Set(payload.productParamIds || []);
  const offerParams = payload.parameters.filter((p) => !productParamSet.has(p.id));
  const productParams = payload.parameters.filter((p) => productParamSet.has(p.id));

  const mapParam = (p: { id: string; values?: string[]; valuesIds?: string[] }) => {
    const mapped: Record<string, unknown> = { id: p.id };
    if (p.valuesIds && p.valuesIds.length > 0) mapped.valuesIds = p.valuesIds;
    if (p.values && p.values.length > 0) mapped.values = p.values;
    return mapped;
  };

  const offerBody: Record<string, unknown> = {
    name: payload.productName,
    category: { id: payload.categoryId },
    sellingMode: {
      format: "BUY_NOW",
      price: { amount: "999", currency: "PLN" },
    },
    stock: {
      available: 1,
      unit: "UNIT",
    },
    publication: {
      status: "ACTIVE",
      duration: null,
    },
    payments: {
      invoice: "VAT",
    },
  };

  // Use productSet structure (new API) when productId is available
  if (payload.productId) {
    const productEntry: Record<string, unknown> = { id: payload.productId };
    if (productParams.length > 0) {
      productEntry.parameters = productParams.map(mapParam);
    }
    offerBody.productSet = [{ product: productEntry }];
    if (offerParams.length > 0) {
      offerBody.parameters = offerParams.map(mapParam);
    }
  } else {
    if (payload.parameters.length > 0) {
      offerBody.parameters = payload.parameters.map(mapParam);
    }
  }

  // Fixed delivery (DOSTAWA)
  if (fixedDefaults.shippingRateId) {
    offerBody.delivery = { shippingRates: { id: fixedDefaults.shippingRateId } };
  }

  // Fixed after-sales services (ZWROT + REKLAMACJA)
  if (fixedDefaults.returnPolicyId || fixedDefaults.impliedWarrantyId) {
    offerBody.afterSalesServices = {
      ...(fixedDefaults.impliedWarrantyId ? { impliedWarranty: { id: fixedDefaults.impliedWarrantyId } } : {}),
      ...(fixedDefaults.returnPolicyId ? { returnPolicy: { id: fixedDefaults.returnPolicyId } } : {}),
    };
  }

  // Upload image to Allegro if provided (skip if already Allegro-hosted)
  if (payload.imageUrl) {
    const isAlreadyAllegro =
      payload.imageUrl.includes("allegroimg.com") ||
      payload.imageUrl.includes("upload.allegro.pl") ||
      payload.imageUrl.includes("allegro.pl/images");
    if (isAlreadyAllegro) {
      offerBody.images = [{ url: payload.imageUrl }];
    } else {
      const allegroImageUrl = await uploadImageToAllegro(payload.imageUrl);
      if (allegroImageUrl) {
        offerBody.images = [{ url: allegroImageUrl }];
      }
    }
  }

  logger.info(
    { productId: payload.productId, categoryId: payload.categoryId, fixedDefaults, hasImage: !!offerBody.images },
    "Creating Allegro offer via product-offers API"
  );

  const response = await axios.post(
    `${ALLEGRO_BASE_URL}/sale/product-offers`,
    offerBody,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.allegro.public.v1+json",
        "Content-Type": "application/vnd.allegro.public.v1+json",
      },
      timeout: 15000,
    }
  );

  return response.data;
}

// Re-export for convenience so callers that imported from allegro.ts still work
export { setUserToken };

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

type AllegroParam = { id: string; values?: string[]; valuesIds?: string[] };

function mapAllegroParam(p: AllegroParam): Record<string, unknown> {
  const m: Record<string, unknown> = { id: p.id };
  if (p.valuesIds && p.valuesIds.length > 0) m.valuesIds = p.valuesIds;
  if (p.values && p.values.length > 0) m.values = p.values;
  return m;
}

function isAllegroHosted(url: string): boolean {
  return (
    url.includes("allegroimg.com") ||
    url.includes("upload.allegro.pl") ||
    url.includes("allegro.pl/images")
  );
}

// Create a product in the Allegro catalog (POST /sale/products)
// Returns the newly created (or existing) product ID.
async function createAllegroProduct(opts: {
  name: string;
  categoryId: string;
  parameters: AllegroParam[];
  imageUrl: string | null;
  ean: string;
}): Promise<string> {
  const token = await getUserToken();

  const body: Record<string, unknown> = {
    name: opts.name,
    category: { id: opts.categoryId },
    parameters: opts.parameters.map(mapAllegroParam),
  };
  if (opts.ean) body.ean = [opts.ean];
  if (opts.imageUrl) body.images = [{ url: opts.imageUrl }];

  logger.info(
    { categoryId: opts.categoryId, ean: opts.ean, paramCount: opts.parameters.length, hasImage: !!opts.imageUrl },
    "Creating product in Allegro catalog"
  );

  try {
    const resp = await axios.post(`${ALLEGRO_BASE_URL}/sale/products`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.allegro.public.v1+json",
        "Content-Type": "application/vnd.allegro.public.v1+json",
      },
      timeout: 20000,
    });
    const productId = (resp.data as { id: string }).id;
    logger.info({ productId }, "Allegro catalog product created");
    return productId;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status?: number; data?: { id?: string; productId?: string } } };
    // 409 Conflict = product already exists in catalog — extract its ID
    if (axiosErr.response?.status === 409) {
      const existingId = axiosErr.response.data?.id || axiosErr.response.data?.productId;
      if (existingId) {
        logger.info({ existingId }, "Product already in Allegro catalog — using existing ID");
        return existingId;
      }
    }
    throw err;
  }
}

export async function createAllegroOffer(payload: {
  productId?: string | null;
  categoryId: string;
  productName: string;
  parameters: AllegroParam[];
  productParamIds?: string[];
  imageUrl?: string | null;
  ean?: string;
  description?: string | null;
}) {
  const token = await getUserToken();

  if (!fixedDefaults.shippingRateId && !fixedDefaults.returnPolicyId && !fixedDefaults.impliedWarrantyId) {
    await loadFixedDefaults();
  }

  // ── Step 1: upload image to Allegro (needed for both product and offer) ──────
  let allegroImageUrl: string | null = null;
  if (payload.imageUrl) {
    if (isAllegroHosted(payload.imageUrl)) {
      allegroImageUrl = payload.imageUrl;
    } else {
      allegroImageUrl = await uploadImageToAllegro(payload.imageUrl);
    }
  }

  // ── Step 2: for non-catalog products, create product in Allegro catalog first ─
  // Parameters that are not allowed in the offer section but ARE valid for products
  const ALWAYS_EXCLUDED_FROM_OFFER = new Set(["224017", "225693", "242901"]);

  let resolvedProductId: string | null = payload.productId || null;

  if (!resolvedProductId && payload.ean) {
    // Non-catalog product: create it in the Allegro catalog
    resolvedProductId = await createAllegroProduct({
      name: payload.productName,
      categoryId: payload.categoryId,
      parameters: payload.parameters, // All params go to the product
      imageUrl: allegroImageUrl,
      ean: payload.ean,
    });
  }

  // ── Step 3: build offer body ───────────────────────────────────────────────
  const productParamSet = new Set(payload.productParamIds || []);
  const offerParams = payload.parameters.filter((p) => !productParamSet.has(p.id));
  const productParams = payload.parameters.filter((p) => productParamSet.has(p.id));

  const offerBody: Record<string, unknown> = {
    name: payload.productName,
    category: { id: payload.categoryId },
    sellingMode: {
      format: "BUY_NOW",
      price: { amount: "999", currency: "PLN" },
    },
    stock: { available: 1, unit: "UNIT" },
    publication: { status: "ACTIVE", duration: null },
    payments: { invoice: "VAT" },
  };

  if (resolvedProductId) {
    // Link to product (catalog or just-created) — product owns all its params
    const productEntry: Record<string, unknown> = { id: resolvedProductId };
    if (productParams.length > 0) {
      productEntry.parameters = productParams.map(mapAllegroParam);
    }
    offerBody.productSet = [{ product: productEntry }];
    // For catalog products, offer can still carry non-product params (filtered)
    // For non-catalog (just created above), we skip offer-level params entirely
    if (payload.productId && offerParams.length > 0) {
      offerBody.parameters = offerParams
        .filter((p) => !ALWAYS_EXCLUDED_FROM_OFFER.has(p.id))
        .map(mapAllegroParam);
    }
  } else {
    // No product at all — pass filtered params directly to offer
    const filtered = payload.parameters.filter((p) => !ALWAYS_EXCLUDED_FROM_OFFER.has(p.id));
    if (filtered.length > 0) offerBody.parameters = filtered.map(mapAllegroParam);
  }

  if (allegroImageUrl) {
    offerBody.images = [{ url: allegroImageUrl }];
  }

  if (payload.description?.trim()) {
    offerBody.description = {
      sections: [
        {
          items: [
            {
              type: "TEXT",
              content: `<p>${payload.description.trim().replace(/\n/g, "<br/>")}</p>`,
            },
          ],
        },
      ],
    };
  }

  if (fixedDefaults.shippingRateId) {
    offerBody.delivery = { shippingRates: { id: fixedDefaults.shippingRateId } };
  }

  if (fixedDefaults.returnPolicyId || fixedDefaults.impliedWarrantyId) {
    offerBody.afterSalesServices = {
      ...(fixedDefaults.impliedWarrantyId ? { impliedWarranty: { id: fixedDefaults.impliedWarrantyId } } : {}),
      ...(fixedDefaults.returnPolicyId ? { returnPolicy: { id: fixedDefaults.returnPolicyId } } : {}),
    };
  }

  // ── Step 4: retry loop for offer creation (auto-strip bad params) ────────────
  function filterOfferParams(excluded: Set<string>) {
    if (resolvedProductId && !payload.productId) {
      // Non-catalog product linked via productSet — no offer-level params
      delete offerBody.parameters;
      return;
    }
    if (resolvedProductId && offerParams.length > 0) {
      const allowed = offerParams.filter((p) => !excluded.has(p.id));
      if (allowed.length > 0) {
        offerBody.parameters = allowed.map(mapAllegroParam);
      } else {
        delete offerBody.parameters;
      }
    } else if (!resolvedProductId) {
      const allowed = payload.parameters.filter((p) => !excluded.has(p.id));
      if (allowed.length > 0) {
        offerBody.parameters = allowed.map(mapAllegroParam);
      } else {
        delete offerBody.parameters;
      }
    }
  }

  const excluded = new Set(ALWAYS_EXCLUDED_FROM_OFFER);
  filterOfferParams(excluded);

  const MAX_RETRIES = 6;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    logger.info(
      {
        productId: resolvedProductId,
        categoryId: payload.categoryId,
        attempt,
        excludedParams: [...excluded],
        hasImage: !!allegroImageUrl,
        hasDescription: !!payload.description,
      },
      "Creating Allegro offer via product-offers API"
    );

    try {
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
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: {
            errors?: Array<{
              code?: string;
              message?: string;
              userMessage?: string;
              path?: string;
              metadata?: Record<string, string>;
            }>;
          };
          status?: number;
        };
        message?: string;
      };

      const errors = axiosErr.response?.data?.errors || [];

      const paramErrors = errors.filter(
        (e) =>
          e.code === "ParameterCategoryException" ||
          (e.userMessage && /should not be specified/i.test(e.userMessage)) ||
          (e.message && /should not be specified/i.test(e.message))
      );

      if (paramErrors.length === 0 || attempt === MAX_RETRIES) {
        throw err;
      }

      let foundNew = false;
      for (const pe of paramErrors) {
        const directId = pe.metadata?.parameterId as string | undefined;
        const text = pe.userMessage || pe.message || "";
        const msgMatch = text.match(/Parameter\s+[`'"]?(\w+):/i);
        const pathMatch = pe.path?.match(/\/parameters\/(\d+)/);

        let paramId: string | undefined = directId || msgMatch?.[1];
        if (!paramId && pathMatch?.[1]) {
          const idx = parseInt(pathMatch[1], 10);
          const currentParams = (offerBody.parameters as Array<{ id: string }> | undefined) || [];
          paramId = currentParams[idx]?.id;
        }

        if (paramId && !excluded.has(paramId)) {
          logger.warn({ paramId, userMessage: pe.userMessage, attempt }, "Auto-excluding parameter and retrying");
          excluded.add(paramId);
          foundNew = true;
        }
      }

      if (!foundNew) throw err;
      filterOfferParams(excluded);
    }
  }
}

// Re-export for convenience so callers that imported from allegro.ts still work
export { setUserToken };

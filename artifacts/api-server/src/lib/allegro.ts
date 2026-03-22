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

  // ── Step 2: fetch category param flags (describesProduct / describesOffer) ────
  const ALLEGRO_HEADERS = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.allegro.public.v1+json",
    "Content-Type": "application/vnd.allegro.public.v1+json",
  };

  // paramFlags: map of paramId → {describesProduct, describesOffer}
  const paramFlags = new Map<string, { describesProduct: boolean; describesOffer: boolean }>();
  // paramNameToId: map of lowercase param name → id (for DuplicateDetectionMissingParametersException)
  const paramNameToId = new Map<string, string>();
  try {
    const rawData = await getCategoryParameters(payload.categoryId);
    const rawParams = (
      rawData as {
        parameters?: Array<{
          id: string;
          name?: string;
          options?: { describesOffer?: boolean; describesProduct?: boolean };
        }>;
      }
    ).parameters || [];
    for (const rp of rawParams) {
      paramFlags.set(rp.id, {
        describesProduct: rp.options?.describesProduct ?? false,
        describesOffer: rp.options?.describesOffer ?? false,
      });
      if (rp.name) paramNameToId.set(rp.name.toLowerCase().trim(), rp.id);
    }
    logger.info({ flagCount: paramFlags.size, categoryId: payload.categoryId }, "Loaded category param flags");
  } catch (flagErr) {
    logger.warn({ flagErr }, "Could not fetch category param flags — will rely on retry to correct placement");
  }

  // ── Step 3: initial split of parameters into product-level vs offer-level ────
  const isNonCatalog = !payload.productId && !!payload.ean;

  // For catalog products we use the productParamIds list from scan
  const catalogProductParamSet = new Set(payload.productParamIds || []);

  function classifyParam(paramId: string): "product" | "offer" {
    const flags = paramFlags.get(paramId);
    if (flags) {
      if (flags.describesProduct && !flags.describesOffer) return "product";
      if (flags.describesOffer && !flags.describesProduct) return "offer";
      if (flags.describesProduct && flags.describesOffer) return "offer"; // both: offer wins
    }
    // Fallback: for catalog products use productParamIds, else default offer
    if (payload.productId && catalogProductParamSet.has(paramId)) return "product";
    return "offer";
  }

  // Mutable arrays — the retry loop can move params between these
  let productLevelParams: AllegroParam[] = [];
  let offerLevelParams: AllegroParam[] = [];

  for (const p of payload.parameters) {
    if (classifyParam(p.id) === "product") {
      productLevelParams.push(p);
    } else {
      offerLevelParams.push(p);
    }
  }

  logger.info(
    {
      productLevelParamIds: productLevelParams.map((p) => p.id),
      offerLevelParamIds: offerLevelParams.map((p) => p.id),
      isNonCatalog,
    },
    "Initial parameter split"
  );

  // ── Step 4: build common offer fields (non-parameter parts) ──────────────────
  const commonOfferFields: Record<string, unknown> = {
    name: payload.productName,
    sellingMode: {
      format: "BUY_NOW",
      price: { amount: "999", currency: "PLN" },
    },
    stock: { available: 1, unit: "UNIT" },
    publication: { status: "ACTIVE" },
    payments: { invoice: "VAT" },
    location: { countryCode: "PL" },
  };

  if (allegroImageUrl) commonOfferFields.images = [allegroImageUrl];

  if (payload.description?.trim()) {
    commonOfferFields.description = {
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
    commonOfferFields.delivery = { shippingRates: { id: fixedDefaults.shippingRateId } };
  }

  if (fixedDefaults.returnPolicyId || fixedDefaults.impliedWarrantyId) {
    commonOfferFields.afterSalesServices = {
      ...(fixedDefaults.impliedWarrantyId ? { impliedWarranty: { id: fixedDefaults.impliedWarrantyId } } : {}),
      ...(fixedDefaults.returnPolicyId ? { returnPolicy: { id: fixedDefaults.returnPolicyId } } : {}),
    };
  }

  // ── Step 5: build the full offer body from current split ─────────────────────
  function buildOfferBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...commonOfferFields,
      category: { id: payload.categoryId },
    };

    if (payload.productId) {
      // Strategy A: existing catalog product
      const productEntry: Record<string, unknown> = { id: payload.productId };
      if (productLevelParams.length > 0) productEntry.parameters = productLevelParams.map(mapAllegroParam);
      body.productSet = [{ product: productEntry }];
      if (offerLevelParams.length > 0) body.parameters = offerLevelParams.map(mapAllegroParam);
    } else if (isNonCatalog) {
      // Strategy B: propose new product via productSet[0].product
      const productProposal: Record<string, unknown> = {
        name: payload.productName,
        category: { id: payload.categoryId },
      };
      if (payload.ean) {
        productProposal.id = payload.ean;
        productProposal.idType = "GTIN";
      }
      if (productLevelParams.length > 0) productProposal.parameters = productLevelParams.map(mapAllegroParam);
      if (allegroImageUrl) productProposal.images = [allegroImageUrl];
      body.productSet = [{ product: productProposal }];
      if (offerLevelParams.length > 0) body.parameters = offerLevelParams.map(mapAllegroParam);
    } else {
      // Strategy C: no EAN / no product — all params at offer level
      if (offerLevelParams.length > 0) body.parameters = offerLevelParams.map(mapAllegroParam);
    }

    return body;
  }

  let offerBody = buildOfferBody();

  // Track which params we have already moved to avoid infinite flip-flopping
  const movedToOffer = new Set<string>();
  const movedToProduct = new Set<string>();
  const droppedEntirely = new Set<string>();

  const MAX_RETRIES = 8;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    logger.info(
      {
        strategy: payload.productId ? "catalog" : isNonCatalog ? "product-proposal" : "direct",
        categoryId: payload.categoryId,
        attempt,
        productLevelParams: productLevelParams,
        offerLevelParams: offerLevelParams,
        requestBody: JSON.stringify(offerBody),
      },
      "POST /sale/product-offers — full request"
    );

    try {
      const response = await axios.post(
        `${ALLEGRO_BASE_URL}/sale/product-offers`,
        offerBody,
        { headers: ALLEGRO_HEADERS, timeout: 20000 }
      );
      logger.info(
        { status: response.status, responseData: JSON.stringify(response.data) },
        "POST /sale/product-offers — success"
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

      logger.error(
        {
          attempt,
          httpStatus: axiosErr.response?.status,
          responseData: JSON.stringify(axiosErr.response?.data),
          requestBodySent: JSON.stringify(offerBody),
        },
        "POST /sale/product-offers — ERROR response"
      );

      const errors = axiosErr.response?.data?.errors || [];

      // ── Handle DuplicateDetectionMissingParametersException ──────────────────
      // Allegro needs certain params in productSet[0].product.parameters for
      // duplicate detection. Error message: "Add parameters: [Pojemność, ...]"
      const ddErrors = errors.filter((e) => e.code === "DuplicateDetectionMissingParametersException");
      if (ddErrors.length > 0 && attempt < MAX_RETRIES) {
        let ddMadeChange = false;
        const missingForUser: string[] = [];

        for (const dde of ddErrors) {
          const text = dde.userMessage || dde.message || "";
          // Extract names inside brackets: "Add parameters: [Pojemność, Smak]"
          const bracketMatch = text.match(/\[([^\]]+)\]/);
          const rawNames = bracketMatch
            ? bracketMatch[1].split(",").map((s: string) => s.trim())
            : [];

          for (const name of rawNames) {
            const paramId = paramNameToId.get(name.toLowerCase().trim());
            if (!paramId) {
              missingForUser.push(name);
              continue;
            }
            const inOffer = offerLevelParams.some((p) => p.id === paramId);
            const inProduct = productLevelParams.some((p) => p.id === paramId);

            if (inOffer) {
              // Move from offer → product so Allegro can run duplicate detection
              const param = offerLevelParams.find((p) => p.id === paramId)!;
              offerLevelParams = offerLevelParams.filter((p) => p.id !== paramId);
              productLevelParams = [...productLevelParams, param];
              movedToProduct.add(paramId);
              logger.warn({ paramId, name, attempt }, "DuplicateDetection: moved param offer→product for detection");
              ddMadeChange = true;
            } else if (!inProduct) {
              // The user never provided a value for this param — we can't add it
              missingForUser.push(name);
            }
            // If already in product — no action needed (shouldn't happen, but safe)
          }
        }

        if (missingForUser.length > 0) {
          // Surface a clear user-facing error listing the missing param names
          const userMsg = `Uzupełnij wymagane parametry do wyszukiwania duplikatów: ${missingForUser.join(", ")}`;
          logger.warn({ missingForUser, attempt }, "DuplicateDetection: missing param values from user");
          const userError = new Error(userMsg) as Error & { allegroErrors?: unknown[]; statusCode?: number };
          userError.allegroErrors = [
            {
              code: "DuplicateDetectionMissingParametersException",
              userMessage: userMsg,
              path: "productSet[0].product.parameters",
            },
          ];
          userError.statusCode = 422;
          throw userError;
        }

        if (ddMadeChange) {
          offerBody = buildOfferBody();
          continue;
        }
      }

      // ── Handle ParameterCategoryException ────────────────────────────────────
      const paramErrors = errors.filter(
        (e) =>
          e.code === "ParameterCategoryException" ||
          (e.userMessage && /should not be specified/i.test(e.userMessage)) ||
          (e.message && /should not be specified/i.test(e.message))
      );

      if (paramErrors.length === 0 || attempt === MAX_RETRIES) {
        throw err;
      }

      let madeChange = false;

      for (const pe of paramErrors) {
        // ── Resolve param ID ─────────────────────────────────────────────────
        const directId = pe.metadata?.parameterId as string | undefined;
        const text = pe.userMessage || pe.message || "";
        // Message format: "Parameter 11323:Stan should not be specified as in section productSet"
        const colonIdMatch = text.match(/Parameter\s+(\d+):/i);
        const wordIdMatch = text.match(/Parameter\s+[`'"]?(\w+):/i);

        let paramId: string | undefined = directId || colonIdMatch?.[1] || wordIdMatch?.[1];

        // Path: /productSet/0/product/parameters/N or /parameters/N
        const productSetPathMatch = pe.path?.match(/productSet.*?\/parameters\/(\d+)/);
        const offerPathMatch = pe.path?.match(/^\/parameters\/(\d+)/);

        if (!paramId && productSetPathMatch?.[1]) {
          const idx = parseInt(productSetPathMatch[1], 10);
          paramId = productLevelParams[idx]?.id;
        }
        if (!paramId && offerPathMatch?.[1]) {
          const idx = parseInt(offerPathMatch[1], 10);
          paramId = offerLevelParams[idx]?.id;
        }

        if (!paramId) continue;

        // ── Determine direction to move ───────────────────────────────────────
        const isInProductSection = productLevelParams.some((p) => p.id === paramId);
        const isInOfferSection = offerLevelParams.some((p) => p.id === paramId);

        if (isInProductSection && !movedToOffer.has(paramId)) {
          // Move from product → offer
          const param = productLevelParams.find((p) => p.id === paramId)!;
          productLevelParams = productLevelParams.filter((p) => p.id !== paramId);
          offerLevelParams = [...offerLevelParams, param];
          movedToOffer.add(paramId);
          logger.warn({ paramId, text, attempt }, "ParameterCategoryException: moved param product→offer");
          madeChange = true;
        } else if (isInOfferSection && !movedToProduct.has(paramId)) {
          // Move from offer → product
          const param = offerLevelParams.find((p) => p.id === paramId)!;
          offerLevelParams = offerLevelParams.filter((p) => p.id !== paramId);
          productLevelParams = [...productLevelParams, param];
          movedToProduct.add(paramId);
          logger.warn({ paramId, text, attempt }, "ParameterCategoryException: moved param offer→product");
          madeChange = true;
        } else if (!droppedEntirely.has(paramId)) {
          // Already moved both ways — drop it entirely
          productLevelParams = productLevelParams.filter((p) => p.id !== paramId);
          offerLevelParams = offerLevelParams.filter((p) => p.id !== paramId);
          droppedEntirely.add(paramId);
          logger.warn({ paramId, attempt }, "ParameterCategoryException: param dropped from both sections");
          madeChange = true;
        }
      }

      if (!madeChange) throw err;

      // Rebuild offer body with updated split
      offerBody = buildOfferBody();
    }
  }
}

// Re-export for convenience so callers that imported from allegro.ts still work
export { setUserToken };

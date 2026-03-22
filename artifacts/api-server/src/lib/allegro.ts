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

export async function createAllegroOffer(payload: {
  productId: string;
  categoryId: string;
  productName: string;
  parameters: Array<{
    id: string;
    values?: string[];
    valuesIds?: string[];
  }>;
}) {
  const token = await getClientCredentialsToken();

  const offerBody = {
    name: payload.productName,
    category: {
      id: payload.categoryId,
    },
    product: {
      id: payload.productId,
    },
    parameters: payload.parameters.map((p) => ({
      id: p.id,
      values: p.values || [],
      valuesIds: p.valuesIds || [],
    })),
    sellingMode: {
      format: "BUY_NOW",
      price: {
        amount: "999",
        currency: "PLN",
      },
    },
    stock: {
      available: 1,
      unit: "UNIT",
    },
    publication: {
      status: "INACTIVE",
    },
    delivery: {
      shippingRates: {
        id: null,
      },
    },
  };

  const response = await axios.post(
    `${ALLEGRO_BASE_URL}/sale/offers`,
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

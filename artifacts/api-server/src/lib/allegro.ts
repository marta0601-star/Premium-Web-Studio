import axios from "axios";
import { logger } from "./logger";

const ALLEGRO_CLIENT_ID = process.env.ALLEGRO_CLIENT_ID;
const ALLEGRO_CLIENT_SECRET = process.env.ALLEGRO_CLIENT_SECRET;
const ALLEGRO_BASE_URL = "https://api.allegro.pl";

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

export async function getAllegroToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
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
    }
  );

  cachedToken = response.data.access_token;
  tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

  logger.info("Allegro token acquired");
  return cachedToken as string;
}

export async function searchCatalogByEan(ean: string) {
  const token = await getAllegroToken();

  const response = await axios.get(`${ALLEGRO_BASE_URL}/sale/products`, {
    params: { ean },
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.allegro.public.v1+json",
    },
  });

  return response.data;
}

export async function getCategoryParameters(categoryId: string) {
  const token = await getAllegroToken();

  const response = await axios.get(
    `${ALLEGRO_BASE_URL}/sale/categories/${categoryId}/parameters`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.allegro.public.v1+json",
      },
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
  const token = await getAllegroToken();

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
    }
  );

  return response.data;
}

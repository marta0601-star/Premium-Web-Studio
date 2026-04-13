import { Router, type IRouter } from "express";
import axios from "axios";
import {
  ScanEanQueryParams,
  CreateOfferBody,
} from "@workspace/api-zod";
import {
  searchCatalogByEan,
  getCategoryParameters,
  getCategoryName,
  createAllegroOffer,
  uploadImageToAllegro,
  uploadImageBinaryToAllegro,
} from "../lib/allegro";
import { getUserToken } from "../lib/allegro-auth";
import { lookupEan } from "../lib/lookup";
import { getSellerSettings, saveSellerSettings } from "../lib/settings";
import {
  detectCategoryKeyword,
  detectBrand,
  detectVolume,
  formatVolumeForContext,
  cleanProductName,
} from "../lib/auto-detect";

const ALLEGRO_BASE_URL = "https://api.allegro.pl";

const router: IRouter = Router();

// ── Helper: map raw Allegro parameter to our API shape ──────────────────────
interface RawAllegroParam {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  requiredForProduct?: boolean;
  unit?: string | null;
  dictionary?: Array<{ id: string; value: string; dependsOnValueIds?: string[] }>;
  restrictions?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

function mapParam(p: RawAllegroParam, required?: boolean) {
  return {
    id: p.id,
    name: p.name,
    type: p.type || "string",
    required: required !== undefined ? required : (p.required ?? false),
    requiredForProduct: p.requiredForProduct ?? false,
    unit: p.unit ?? null,
    options: (p.dictionary || []).map((d) => ({ id: d.id, name: d.value })),
    restrictions: p.restrictions ?? null,
  };
}

// ── GET /api/allegro/scan ────────────────────────────────────────────────────
router.get("/scan", async (req, res) => {
  try {
    const { ean } = ScanEanQueryParams.parse(req.query);

    // Step 1: Try Allegro catalog FIRST (user-level OAuth token required)
    let allegroProduct: null | Record<string, unknown> = null;

    try {
      const catalogData = await searchCatalogByEan(ean);
      const products = (catalogData as { products?: unknown[] }).products;
      if (products && products.length > 0) {
        allegroProduct = products[0] as Record<string, unknown>;
        req.log.info(
          { productId: allegroProduct.id, productName: allegroProduct.name },
          "Allegro catalog product selected"
        );
      }
    } catch (allegroErr: unknown) {
      const e = allegroErr as { response?: { status?: number }; message?: string };
      req.log.warn(
        { status: e.response?.status, msg: e.message },
        "Allegro catalog search failed — will try external lookup"
      );
    }

    // Step 2: If Allegro returned a product, fetch parameters and return
    if (allegroProduct) {
      const product = allegroProduct;
      const cat = product.category as { id?: string; name?: string } | undefined;
      const categoryId = cat?.id ?? null;
      const categoryName = cat?.name ?? "";
      const productId = product.id as string;
      const productName = product.name as string;
      const images = ((product.images as Array<{ url: string }>) || []).map(
        (img) => ({ url: img.url })
      );

      // Build prefillValues from catalog product.parameters
      const prefillValues: Record<string, string[]> = {};
      const rawProductParams = (product.parameters as Array<{
        id: string;
        values?: string[];
        valuesIds?: string[];
        rangeValue?: { from?: string; to?: string };
      }>) || [];

      for (const pp of rawProductParams) {
        if (pp.valuesIds && pp.valuesIds.length > 0) {
          prefillValues[pp.id] = pp.valuesIds;
        } else if (pp.values && pp.values.length > 0) {
          prefillValues[pp.id] = pp.values;
        }
      }

      // Fetch category parameters + product-parameters + name in parallel
      let parameters: ReturnType<typeof mapParam>[] = [];
      let productParamIds: string[] = [];
      let resolvedCategoryName = categoryName;

      if (categoryId) {
        const token = await getUserToken();
        const headers = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.allegro.public.v1+json",
        };

        const [parametersResult, productParamsResult, nameResult] = await Promise.allSettled([
          getCategoryParameters(categoryId),
          axios.get(`${ALLEGRO_BASE_URL}/sale/categories/${categoryId}/product-parameters?language=pl-PL`, { headers, timeout: 8000 }),
          !categoryName ? getCategoryName(categoryId) : Promise.resolve(categoryName),
        ]);

        if (parametersResult.status === "fulfilled") {
          const allParams: RawAllegroParam[] = (parametersResult.value as { parameters?: RawAllegroParam[] }).parameters || [];
          parameters = allParams.map((p) => mapParam(p));
        } else {
          const e = parametersResult.reason as { response?: { status?: number }; message?: string };
          req.log.warn({ categoryId, status: e.response?.status, msg: e.message }, "Could not fetch category parameters");
        }

        if (productParamsResult.status === "fulfilled") {
          const productParams = (productParamsResult.value.data as { parameters?: RawAllegroParam[] }).parameters || [];
          productParamIds = productParams.map((p) => p.id);
        }

        if (nameResult.status === "fulfilled") {
          resolvedCategoryName = nameResult.value as string;
        }
      }

      res.json({
        productId,
        productName,
        categoryId,
        categoryName: resolvedCategoryName,
        images,
        parameters,
        prefillValues,
        productParamIds,
        source: "allegro_catalog",
        ean,
      });
      return;
    }

    // Step 3: External fallback
    req.log.info({ ean }, "Allegro catalog empty — trying external lookup");
    const result = await lookupEan(ean);

    if (!result.found) {
      res.status(404).json({
        error: "not_found",
        message: "Nie znaleziono produktu dla podanego kodu EAN",
        logs: result.logs,
        ean,
      });
      return;
    }

    // ── Step 3a: Auto-detect from lookup result ──────────────────────────────
    const rawName = result.name || "";
    const detectedBrand = detectBrand(rawName, result.brand || null);
    const detectedVolume = detectVolume(rawName, result.weight || null);
    const categoryKeyword = detectCategoryKeyword(rawName);
    const cleanedName = cleanProductName(rawName, detectedBrand, detectedVolume);
    const normalizedWeight = detectedVolume ? formatVolumeForContext(detectedVolume) : (result.weight || null);

    req.log.info(
      { rawName, cleanedName, detectedBrand, detectedVolume, categoryKeyword },
      "Auto-detection results"
    );

    // ── Step 3b: Resolve Allegro category via matching-categories API ─────────
    let detectedCategoryId = "258832"; // fallback: Supermarket (correct Allegro root)
    let detectedCategoryName = "Supermarket";
    const searchPhrase = cleanedName || categoryKeyword;

    try {
      const token = await getUserToken();
      const catResp = await axios.get(
        `${ALLEGRO_BASE_URL}/sale/matching-categories?name=${encodeURIComponent(searchPhrase)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.allegro.public.v1+json",
          },
          timeout: 5000,
        }
      );
      // Allegro returns "matchingCategories" (array), not "matchingCategory"
      const cats = (catResp.data as { matchingCategories?: Array<{ id: string; name: string }> }).matchingCategories || [];
      // Find the best match: prefer exact or closest name match against our keyword
      const kwLower = searchPhrase.toLowerCase();
      let bestCat = cats[0];
      for (const cat of cats) {
        const cLower = cat.name.toLowerCase();
        if (cLower === kwLower || cLower.includes(kwLower) || kwLower.includes(cLower)) {
          bestCat = cat;
          break;
        }
      }
      if (bestCat?.id) {
        detectedCategoryId = bestCat.id;
        detectedCategoryName = bestCat.name;
        req.log.info(
          { phrase: searchPhrase, categoryId: detectedCategoryId, categoryName: detectedCategoryName, candidateCount: cats.length },
          "Category detected via Allegro API"
        );
      }
    } catch (catErr: unknown) {
      const e = catErr as { message?: string };
      req.log.warn({ phrase: searchPhrase, msg: e.message }, "matching-categories failed — using fallback");
    }

    // ── Step 3c: Fetch category parameters + product-parameter IDs ────────────
    let parameters: ReturnType<typeof mapParam>[] = [];
    let productParamIds: string[] = [];

    try {
      const token = await getUserToken();
      const hdr = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.allegro.public.v1+json",
      };
      const [paramsRes, ppRes] = await Promise.allSettled([
        getCategoryParameters(detectedCategoryId),
        axios.get(
          `${ALLEGRO_BASE_URL}/sale/categories/${detectedCategoryId}/product-parameters?language=pl-PL`,
          { headers: hdr, timeout: 8000 }
        ),
      ]);

      if (paramsRes.status === "fulfilled") {
        const all: RawAllegroParam[] =
          (paramsRes.value as { parameters?: RawAllegroParam[] }).parameters || [];
        parameters = all.map((p) => mapParam(p));
      } else {
        req.log.warn({ categoryId: detectedCategoryId }, "Could not fetch parameters for detected category");
      }

      if (ppRes.status === "fulfilled") {
        const pp = (ppRes.value.data as { parameters?: RawAllegroParam[] }).parameters || [];
        productParamIds = pp.map((p) => p.id);
      }
    } catch (paramErr: unknown) {
      const e = paramErr as { message?: string };
      req.log.warn({ msg: e.message }, "Error fetching category parameters");
    }

    req.log.info(
      { categoryId: detectedCategoryId, paramCount: parameters.length, productParamCount: productParamIds.length },
      "Category parameters loaded"
    );

    res.json({
      productId: null,
      productName: cleanedName,
      categoryId: detectedCategoryId,
      categoryName: detectedCategoryName,
      images: result.image ? [{ url: result.image }] : [],
      parameters,
      prefillValues: {},
      productParamIds,
      source: result.source,
      brand: detectedBrand,
      weight: normalizedWeight,
      category: result.category,
      logs: result.logs,
      ean,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error scanning EAN");
    res.status(500).json({
      error: "server_error",
      message: "Błąd podczas pobierania danych produktu",
    });
  }
});

// ── GET /api/allegro/matching-categories?name={name} ────────────────────────
// Returns suggested Allegro categories for a product name (for external products)
router.get("/matching-categories", async (req, res) => {
  const { name } = req.query as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "name parameter required" });
    return;
  }

  try {
    const token = await getUserToken();
    const response = await axios.get(
      `${ALLEGRO_BASE_URL}/sale/matching-categories?name=${encodeURIComponent(name.trim())}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.allegro.public.v1+json",
        },
        timeout: 8000,
      }
    );
    res.json(response.data);
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    req.log.warn({ status: e.response?.status, msg: e.message }, "matching-categories failed");
    res.status(e.response?.status || 500).json({
      error: "allegro_error",
      details: e.response?.data,
      message: e.message,
    });
  }
});

// ── GET /api/allegro/category-children?id={parentId} ────────────────────────
// Returns direct subcategories of a given category (used for Supermarket drill-down)
router.get("/category-children", async (req, res) => {
  const { id } = req.query as { id?: string };
  if (!id?.trim()) {
    res.status(400).json({ error: "id parameter required" });
    return;
  }

  try {
    const token = await getUserToken();
    // "root" is a special value that fetches top-level categories (no parent.id filter)
    const apiUrl = id.trim() === "root"
      ? `${ALLEGRO_BASE_URL}/sale/categories`
      : `${ALLEGRO_BASE_URL}/sale/categories?parent.id=${encodeURIComponent(id.trim())}`;
    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.allegro.public.v1+json",
      },
      timeout: 8000,
    });
    const raw = (response.data as { categories?: Array<{ id: string; name: string; leaf?: boolean }> }).categories || [];
    res.json({
      categories: raw.map((c) => ({ id: c.id, name: c.name, leaf: c.leaf ?? false })),
    });
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    req.log.warn({ id, status: e.response?.status, msg: e.message }, "category-children failed");
    res.status(e.response?.status || 500).json({
      error: "allegro_error",
      message: e.message,
      categories: [],
    });
  }
});

// ── GET /api/allegro/category-search?q=phrase ────────────────────────────────
// Returns categories matching a phrase (used by the category picker search box)
router.get("/category-search", async (req, res) => {
  const { q } = req.query as { q?: string };
  if (!q?.trim()) {
    res.json({ categories: [] });
    return;
  }
  try {
    const token = await getUserToken();
    const response = await axios.get(
      `${ALLEGRO_BASE_URL}/sale/matching-categories?name=${encodeURIComponent(q.trim())}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.allegro.public.v1+json",
        },
        timeout: 5000,
      }
    );
    const cats = (response.data as { matchingCategories?: Array<{ id: string; name: string; leaf?: boolean }> }).matchingCategories || [];
    res.json({ categories: cats.map((c) => ({ id: c.id, name: c.name, leaf: c.leaf ?? true })) });
  } catch (err: unknown) {
    const e = err as { message?: string };
    req.log.warn({ q, msg: e.message }, "category-search failed");
    res.json({ categories: [] });
  }
});

// ── GET /api/allegro/category-parameters/:categoryId ────────────────────────
// Returns ALL parameters for a category (cached-friendly, used by the form)
router.get("/category-parameters/:categoryId", async (req, res) => {
  const { categoryId } = req.params;
  if (!categoryId?.trim()) {
    res.status(400).json({ error: "categoryId required" });
    return;
  }

  try {
    const parametersData = await getCategoryParameters(categoryId);
    const allParams: RawAllegroParam[] = (parametersData as { parameters?: RawAllegroParam[] }).parameters || [];
    res.json({
      categoryId,
      parameters: allParams.map((p) => mapParam(p)),
    });
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    req.log.warn({ categoryId, status: e.response?.status, msg: e.message }, "category-parameters failed");
    res.status(e.response?.status || 500).json({
      error: "allegro_error",
      message: e.message,
      details: e.response?.data,
    });
  }
});


// ── POST /api/allegro/upload-image ──────────────────────────────────────────
// Accepts a binary image body (Content-Type: image/*) from the client,
// uploads it to Allegro, and returns the hosted Allegro image URL.
router.post("/upload-image", async (req, res) => {
  try {
    const contentType = (req.headers["content-type"] as string) || "image/jpeg";

    // If client sent a JSON body with a URL, forward that URL
    if (contentType.includes("application/json")) {
      const { url } = req.body as { url?: string };
      if (!url) {
        res.status(400).json({ error: "url field required in body" });
        return;
      }
      const allegroUrl = await uploadImageToAllegro(url);
      if (!allegroUrl) {
        res.status(502).json({ error: "Failed to upload image URL to Allegro" });
        return;
      }
      res.json({ url: allegroUrl });
      return;
    }

    // Binary image body
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const data = Buffer.concat(chunks);
      if (!data.length) {
        res.status(400).json({ error: "Empty image body" });
        return;
      }
      const allegroUrl = await uploadImageBinaryToAllegro(data, contentType.split(";")[0].trim());
      if (!allegroUrl) {
        res.status(502).json({ error: "Failed to upload image to Allegro" });
        return;
      }
      res.json({ url: allegroUrl });
    });
    req.on("error", (err) => {
      req.log.error({ err }, "Error reading upload-image request body");
      res.status(500).json({ error: "Error reading image data" });
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error in upload-image endpoint");
    res.status(500).json({ error: "server_error" });
  }
});

// ── POST /api/allegro/create-offer ──────────────────────────────────────────
router.post("/create-offer", async (req, res) => {
  try {
    const body = CreateOfferBody.parse(req.body);

    const offer = await createAllegroOffer(body);
    const offerId = (offer as { id?: string }).id ?? "";
    const status = (offer as { publication?: { status?: string } }).publication?.status || "INACTIVE";

    type ProductSet = { product?: { publication?: { status?: string } } };
    const productStatus = (offer as { productSet?: ProductSet[] }).productSet?.[0]?.product?.publication?.status;

    let message: string;
    if (status === "ACTIVE") {
      message = `Oferta aktywna na Allegro za 999 PLN!`;
    } else if (productStatus === "PROPOSED") {
      message = `Oferta złożona! Produkt oczekuje na akceptację Allegro — oferta aktywuje się automatycznie po zatwierdzeniu (zazwyczaj do 24h).`;
    } else {
      message = `Oferta utworzona (status: ${status}). Sprawdź szczegóły w panelu Allegro.`;
    }

    res.json({
      offerId,
      status,
      productStatus: productStatus || null,
      offerUrl: `https://allegro.pl/oferta/${offerId}`,
      message,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error creating offer");

    // Custom error thrown when user is missing param values for DuplicateDetection
    const customErr = err as { allegroErrors?: unknown[]; statusCode?: number; message?: string };
    if (customErr.allegroErrors) {
      const errors = customErr.allegroErrors as Array<{ code?: string; message?: string; path?: string; userMessage?: string }>;
      req.log.error({ errors }, "Allegro DuplicateDetection missing params (user must fill in)");
      res.status(422).json({
        error: "allegro_error",
        message: errors.map((e) => e.userMessage || e.message || e.code).join("; ") || "Błąd Allegro",
        errors,
      });
      return;
    }

    const axiosErr = err as {
      response?: {
        data?: { errors?: Array<{ code?: string; message?: string; path?: string; userMessage?: string }> };
        status?: number;
      };
    };
    if (axiosErr.response?.data?.errors) {
      const errors = axiosErr.response.data.errors;
      req.log.error({ errors }, "Allegro API validation errors");
      res.status(400).json({
        error: "allegro_error",
        message: errors.map((e) => e.userMessage || e.message || e.code).join("; ") || "Błąd Allegro",
        errors,
      });
      return;
    }
    res.status(500).json({
      error: "server_error",
      message: "Błąd podczas tworzenia oferty na Allegro",
      errors: [],
    });
  }
});

// ── GET /api/allegro/settings ────────────────────────────────────────────────
router.get("/settings", (_req, res) => {
  const seller = getSellerSettings();
  res.json({ seller: seller ?? null });
});

// ── PUT /api/allegro/settings ────────────────────────────────────────────────
router.put("/settings", (req, res) => {
  try {
    const { city, postCode, state } = req.body as { city?: string; postCode?: string; state?: string };
    if (!city || !postCode || !state) {
      res.status(400).json({ error: "city, postCode i state są wymagane" });
      return;
    }
    const postCodeRe = /^\d{2}-\d{3}$/;
    if (!postCodeRe.test(postCode)) {
      res.status(400).json({ error: "Kod pocztowy musi być w formacie XX-XXX" });
      return;
    }
    saveSellerSettings({ city: city.trim(), postCode: postCode.trim(), state: state.trim().toUpperCase() });
    res.json({ ok: true, seller: { city, postCode, state } });
  } catch (err) {
    res.status(500).json({ error: "Błąd podczas zapisywania ustawień" });
  }
});

export default router;

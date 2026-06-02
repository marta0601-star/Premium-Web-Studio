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
  resolveLeafCategory,
  fetchCategoryChildrenList,
  SUPERMARKET_CATEGORY_ID,
} from "../lib/allegro";
import { getUserToken } from "../lib/allegro-auth";
import { lookupEan } from "../lib/lookup";
import { isVisionEnabled, extractProductFromImage } from "../lib/vision";
import { getSellerSettings, saveSellerSettings } from "../lib/settings";
import {
  detectCategoryKeyword,
  detectBrand,
  detectVolume,
  formatVolumeForContext,
  cleanProductName,
} from "../lib/auto-detect";
import {
  fillCategoryParameters,
  filledToPrefillValues,
  deriveOffTypeHint,
  type AllegroFillerParam,
} from "../lib/parameter-filler";

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

      // ── Catalog smart-fill parity ─────────────────────────────────────────
      // The catalog hit is the highest-confidence path but historically got
      // ZERO smart fill — only the catalog product's own parameter values. Run
      // the same param-filler used on the external branch so condition=Nowy,
      // EAN, brand, weight, country, rodzaj/smak are added on top. Catalog
      // values stay authoritative for this exact product; the filler only
      // populates parameters the catalog product didn't carry.
      const catBrand = detectBrand(productName, null);
      const catKeyword = detectCategoryKeyword(productName);
      const catVol = detectVolume(
        productName,
        null,
        catKeyword ?? resolvedCategoryName ?? null,
      );
      const catWeight = catVol ? formatVolumeForContext(catVol) : null;

      const catFillerInput: AllegroFillerParam[] = parameters.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        required: p.required,
        options: p.options,
        unit: p.unit,
      }));
      const catFiller = fillCategoryParameters(catFillerInput, {
        productName,
        brand: catBrand,
        categoryKeyword: catKeyword,
        ean,
        weight: catWeight,
        // No OFF probe here — keep the catalog path fast (zero extra network).
        offMeta: undefined,
      });

      const catalogFilledIds = new Set(Object.keys(prefillValues));
      const catalogParamById = new Map(parameters.map((p) => [p.id, p]));

      // Filler fills only what the catalog didn't, and we push those into
      // prefillValues so the existing frontend prefill path renders them too.
      const fillerAdded = catFiller.filled.filter((f) => !catalogFilledIds.has(f.id));
      for (const f of fillerAdded) {
        prefillValues[f.id] = [f.value];
      }

      // Source-attributed list for the UI: catalog values (authoritative) +
      // the filler's additions, each carrying its own confidence/source.
      const filledParameters = [
        ...Array.from(catalogFilledIds).map((id) => {
          const p = catalogParamById.get(id);
          return {
            id,
            name: p?.name ?? id,
            value: prefillValues[id]?.[0] ?? "",
            kind: (p?.type === "dictionary" ? "valuesIds" : "values") as
              | "values"
              | "valuesIds",
            confidence: "high" as const,
            source: "allegro_catalog" as const,
          };
        }),
        ...fillerAdded,
      ];

      res.json({
        productId,
        productName,
        categoryId,
        categoryName: resolvedCategoryName,
        categoryConfidence: "high",
        categoryLeaf: true,
        images,
        parameters,
        prefillValues,
        productParamIds,
        filledParameters,
        skippedParameters: catFiller.skipped,
        source: "allegro_catalog",
        brand: catBrand,
        weight: catWeight,
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
        debug: result.debug,
        ean,
      });
      return;
    }

    // ── Step 3a: Auto-detect from lookup result ──────────────────────────────
    const rawName = result.name || "";
    const detectedBrand = detectBrand(rawName, result.brand || null);
    const categoryKeyword = detectCategoryKeyword(rawName);
    // Volume detection runs BEFORE name cleanup so a sanity-rejected weight
    // (e.g. "3 g" inside a candy name) is reported via weightSanity AND
    // cleanProductName can strip the trailing token. We use the keyword as
    // category context — fall back to OFF category string if keyword missed.
    const weightSanityProbe: { reason?: string } = {};
    const weightCategoryHint = categoryKeyword ?? result.category ?? null;
    const detectedVolume = detectVolume(
      rawName,
      result.weight || null,
      weightCategoryHint,
      weightSanityProbe,
    );
    const cleanedName = cleanProductName(rawName, detectedBrand, detectedVolume);
    const normalizedWeight = detectedVolume ? formatVolumeForContext(detectedVolume) : null;

    req.log.info(
      {
        rawName,
        cleanedName,
        detectedBrand,
        detectedVolume,
        categoryKeyword,
        weightSanity: weightSanityProbe.reason,
      },
      "Auto-detection results"
    );

    // ── Step 3b: Resolve a LEAF category, anchored to the Supermarket subtree
    // The whole product domain is food (Supermarket #258832). We therefore
    // PRIMARILY drill the Supermarket subtree by similarity, which guarantees
    // we land on a food leaf and never misroute a marketing-heavy name into a
    // non-food category. Only if that finds nothing usable do we fall back to
    // the historical matching-categories flow (rare non-food / bundled items).
    let detectedCategoryId: string | null = null;
    let detectedCategoryName: string | null = null;
    let categoryPath: string[] = [];
    let categoryLeaf = false;
    let categoryConfidence: "high" | "medium" | "low" | "none" = "none";
    let categoryResolutionTrace: unknown = undefined;
    const searchPhrase = cleanedName || categoryKeyword || "";
    // Extra drill hint: a PL product-type derived from OFF tags (Czekolada,
    // Żelki, Kawa…) so the Supermarket walk matches subcategory names even when
    // the product name yields no keyword.
    const drillKeyword = categoryKeyword ?? deriveOffTypeHint(result.meta);

    // PRIMARY: drill from Supermarket #258832.
    const supermarketResolved = await resolveLeafCategory(
      SUPERMARKET_CATEGORY_ID,
      cleanedName,
      detectedBrand,
      drillKeyword,
    );
    if (supermarketResolved.leaf && supermarketResolved.categoryId) {
      detectedCategoryId = supermarketResolved.categoryId;
      detectedCategoryName = supermarketResolved.categoryName;
      categoryPath = supermarketResolved.categoryPath;
      categoryLeaf = true;
      categoryConfidence = supermarketResolved.confidence;
      req.log.info(
        {
          categoryId: detectedCategoryId,
          categoryName: detectedCategoryName,
          path: categoryPath,
          confidence: categoryConfidence,
        },
        "Leaf category resolved under Supermarket subtree"
      );
    }
    categoryResolutionTrace = {
      strategy: "supermarket-first",
      supermarket: {
        seedId: SUPERMARKET_CATEGORY_ID,
        path: supermarketResolved.categoryPath,
        confidence: supermarketResolved.confidence,
        leaf: supermarketResolved.leaf,
        steps: supermarketResolved.trace,
      },
    };

    // FALLBACK: matching-categories, only if Supermarket drill found no leaf.
    if (!detectedCategoryId) {
      let initialMatchId: string | null = null;
      let initialMatchName: string | null = null;
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
        const cats =
          (catResp.data as { matchingCategories?: Array<{ id: string; name: string }> })
            .matchingCategories || [];
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
          initialMatchId = bestCat.id;
          initialMatchName = bestCat.name;
          req.log.info(
            {
              phrase: searchPhrase,
              initialId: initialMatchId,
              initialName: initialMatchName,
              candidateCount: cats.length,
            },
            "matching-categories fallback candidate"
          );
        }
      } catch (catErr: unknown) {
        const e = catErr as { message?: string };
        req.log.warn({ phrase: searchPhrase, msg: e.message }, "matching-categories failed");
      }

      if (initialMatchId) {
        const resolved = await resolveLeafCategory(
          initialMatchId,
          cleanedName,
          detectedBrand,
          drillKeyword,
        );
        categoryResolutionTrace = {
          strategy: "matching-categories-fallback",
          supermarket: {
            seedId: SUPERMARKET_CATEGORY_ID,
            confidence: supermarketResolved.confidence,
            leaf: supermarketResolved.leaf,
          },
          initial: { id: initialMatchId, name: initialMatchName },
          path: resolved.categoryPath,
          confidence: resolved.confidence,
          leaf: resolved.leaf,
          steps: resolved.trace,
        };
        if (resolved.leaf && resolved.categoryId) {
          detectedCategoryId = resolved.categoryId;
          detectedCategoryName = resolved.categoryName;
          categoryPath = resolved.categoryPath;
          categoryLeaf = true;
          categoryConfidence = resolved.confidence;
          req.log.info(
            {
              categoryId: detectedCategoryId,
              categoryName: detectedCategoryName,
              path: categoryPath,
              confidence: categoryConfidence,
            },
            "Leaf category resolved (fallback)"
          );
        } else {
          req.log.warn(
            { initialId: initialMatchId, trace: resolved.trace },
            "Leaf resolution failed — frontend will prompt manual selection"
          );
        }
      }
    }

    // ── Step 3c: Fetch category parameters + product-parameter IDs ────────────
    let parameters: ReturnType<typeof mapParam>[] = [];
    let productParamIds: string[] = [];
    let rawCategoryParams: RawAllegroParam[] = [];

    if (detectedCategoryId) {
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
          rawCategoryParams =
            (paramsRes.value as { parameters?: RawAllegroParam[] }).parameters || [];
          parameters = rawCategoryParams.map((p) => mapParam(p));
        } else {
          req.log.warn({ categoryId: detectedCategoryId }, "Could not fetch parameters");
        }

        if (ppRes.status === "fulfilled") {
          const pp = (ppRes.value.data as { parameters?: RawAllegroParam[] }).parameters || [];
          productParamIds = pp.map((p) => p.id);
        }
      } catch (paramErr: unknown) {
        const e = paramErr as { message?: string };
        req.log.warn({ msg: e.message }, "Error fetching category parameters");
      }
    }

    // ── Step 3d: Auto-fill category parameters from lookup data ──────────────
    const fillerInput: AllegroFillerParam[] = parameters.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      required: p.required,
      options: p.options,
      unit: p.unit,
    }));
    const fillerOutput = fillCategoryParameters(fillerInput, {
      productName: cleanedName,
      brand: detectedBrand,
      categoryKeyword,
      ean,
      weight: normalizedWeight,
      offMeta: result.meta,
    });
    const prefillValues = filledToPrefillValues(fillerOutput.filled);

    req.log.info(
      {
        categoryId: detectedCategoryId,
        paramCount: parameters.length,
        productParamCount: productParamIds.length,
        fillerStats: fillerOutput.stats,
      },
      "Category parameters loaded + auto-filled"
    );

    res.json({
      productId: null,
      productName: cleanedName,
      categoryId: detectedCategoryId,
      categoryName: detectedCategoryName,
      categoryPath,
      categoryLeaf,
      categoryConfidence,
      images: result.image ? [{ url: result.image }] : [],
      parameters,
      prefillValues,
      productParamIds,
      filledParameters: fillerOutput.filled,
      skippedParameters: fillerOutput.skipped,
      source: result.source,
      brand: detectedBrand,
      weight: normalizedWeight,
      category: result.category,
      meta: result.meta,
      logs: result.logs,
      debug: {
        ...(result.debug ?? {}),
        weightSanity: weightSanityProbe.reason,
        categoryResolution: categoryResolutionTrace,
        filling: fillerOutput.stats,
      },
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
    const categories = await fetchCategoryChildrenList(id.trim());
    res.json({ categories });
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

// ── POST /api/allegro/scan-photo ────────────────────────────────────────────
// Vision fallback: when EAN lookup found nothing, the client posts a package
// photo (binary image body, optional ?ean=). Claude extracts product fields,
// which then flow through the SAME Supermarket-anchored category resolution +
// param-filler as a normal scan, so the draft shape is identical.
// Gated behind ANTHROPIC_API_KEY — returns 503 when the feature is off.
router.post("/scan-photo", async (req, res) => {
  if (!isVisionEnabled()) {
    res.status(503).json({
      error: "vision_disabled",
      message: "Rozpoznawanie ze zdjęcia jest wyłączone (brak ANTHROPIC_API_KEY).",
    });
    return;
  }

  const contentType = ((req.headers["content-type"] as string) || "image/jpeg")
    .split(";")[0]
    .trim();
  const ean = typeof req.query.ean === "string" ? req.query.ean : "";

  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("error", (err) => {
    req.log.error({ err }, "scan-photo: error reading body");
    res.status(500).json({ error: "read_error" });
  });
  req.on("end", async () => {
    try {
      const data = Buffer.concat(chunks);
      if (!data.length) {
        res.status(400).json({ error: "empty_image" });
        return;
      }

      const vision = await extractProductFromImage(data.toString("base64"), contentType);
      if (!vision) {
        res.status(404).json({
          error: "vision_no_data",
          message: "Nie udało się rozpoznać produktu ze zdjęcia.",
        });
        return;
      }

      // Build a name from the recognised parts (flavour included so the filler's
      // name-keyword extraction can use it), then run the same detection chain.
      const rawName = [vision.brand, vision.name, vision.flavor]
        .filter(Boolean)
        .join(" ")
        .trim();
      const detectedBrand = detectBrand(rawName, vision.brand);
      const categoryKeyword = detectCategoryKeyword(rawName);
      const weightProbe: { reason?: string } = {};
      const detectedVolume = detectVolume(
        rawName,
        vision.weight,
        categoryKeyword ?? null,
        weightProbe,
      );
      const cleanedName = cleanProductName(rawName, detectedBrand, detectedVolume);
      const normalizedWeight = detectedVolume
        ? formatVolumeForContext(detectedVolume)
        : vision.weight;

      // Vision gives no OFF category tags; pass ingredients + country (origin) so
      // the filler's country branch and ingredient-aware logic still work.
      const meta = {
        ingredients: vision.ingredients ?? undefined,
        originsTags: vision.country ? [vision.country] : undefined,
      };

      // Resolve a leaf under Supermarket (#258832). Vision items are the long
      // tail, so we keep it simple: Supermarket drill only, manual pick if it
      // doesn't land (the UI already supports changing the category).
      const drillKeyword = categoryKeyword ?? deriveOffTypeHint(meta);
      const resolved = await resolveLeafCategory(
        SUPERMARKET_CATEGORY_ID,
        cleanedName,
        detectedBrand,
        drillKeyword,
      );
      const detectedCategoryId = resolved.leaf ? resolved.categoryId : null;

      let parameters: ReturnType<typeof mapParam>[] = [];
      let productParamIds: string[] = [];
      if (detectedCategoryId) {
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
              { headers: hdr, timeout: 8000 },
            ),
          ]);
          if (paramsRes.status === "fulfilled") {
            const raw = (paramsRes.value as { parameters?: RawAllegroParam[] }).parameters || [];
            parameters = raw.map((p) => mapParam(p));
          }
          if (ppRes.status === "fulfilled") {
            const pp = (ppRes.value.data as { parameters?: RawAllegroParam[] }).parameters || [];
            productParamIds = pp.map((p) => p.id);
          }
        } catch (paramErr: unknown) {
          const e = paramErr as { message?: string };
          req.log.warn({ msg: e.message }, "scan-photo: error fetching parameters");
        }
      }

      const fillerInput: AllegroFillerParam[] = parameters.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        required: p.required,
        options: p.options,
        unit: p.unit,
      }));
      const fillerOutput = fillCategoryParameters(fillerInput, {
        productName: cleanedName || rawName,
        brand: detectedBrand,
        categoryKeyword,
        ean,
        weight: normalizedWeight,
        offMeta: meta,
      });
      const prefillValues = filledToPrefillValues(fillerOutput.filled);

      req.log.info(
        { vision, categoryId: detectedCategoryId, fillerStats: fillerOutput.stats },
        "scan-photo: draft built from vision",
      );

      res.json({
        productId: null,
        productName: cleanedName || rawName,
        categoryId: detectedCategoryId,
        categoryName: resolved.categoryName,
        categoryPath: resolved.categoryPath,
        categoryLeaf: resolved.leaf,
        categoryConfidence: resolved.confidence,
        images: [],
        parameters,
        prefillValues,
        productParamIds,
        filledParameters: fillerOutput.filled,
        skippedParameters: fillerOutput.skipped,
        source: "vision",
        brand: detectedBrand,
        weight: normalizedWeight,
        vision,
        ean,
      });
    } catch (err: unknown) {
      req.log.error({ err }, "scan-photo: failed");
      res.status(500).json({ error: "server_error" });
    }
  });
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

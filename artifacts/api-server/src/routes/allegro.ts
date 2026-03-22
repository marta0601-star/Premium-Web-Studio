import { Router, type IRouter } from "express";
import {
  ScanEanQueryParams,
  CreateOfferBody,
} from "@workspace/api-zod";
import {
  searchCatalogByEan,
  getCategoryParameters,
  createAllegroOffer,
} from "../lib/allegro";
import { lookupEan } from "../lib/lookup";

const router: IRouter = Router();

router.get("/scan", async (req, res) => {
  try {
    const { ean } = ScanEanQueryParams.parse(req.query);

    // ── Step 1: Try Allegro catalog FIRST (requires user-level OAuth token) ──
    // If this succeeds and returns a product, we STOP here — no external lookup.
    // Only fall through to external sources if the catalog returns nothing OR
    // if no user token is available (throws).
    let allegroProduct: null | {
      id: string;
      name: string;
      category?: { id: string; name?: string };
      images?: Array<{ url: string }>;
      parameters?: Array<{ id: string; values?: string[]; valuesIds?: string[] }>;
    } = null;

    try {
      const catalogData = await searchCatalogByEan(ean);
      const products = catalogData.products;
      if (products && products.length > 0) {
        allegroProduct = products[0];
        req.log.info({ productId: allegroProduct!.id, productName: allegroProduct!.name }, "Allegro catalog product selected");
      }
    } catch (allegroErr: unknown) {
      const e = allegroErr as { response?: { status?: number }; message?: string };
      req.log.warn(
        { status: e.response?.status, msg: e.message },
        "Allegro catalog search failed — will try external lookup"
      );
    }

    // ── Step 2: If Allegro returned a product, use it (ALWAYS wins) ──
    if (allegroProduct) {
      const product = allegroProduct;
      const categoryId = product.category?.id ?? null;
      const productId = product.id;
      const productName = product.name;
      const categoryName = product.category?.name ?? "";
      const images = (product.images || []).map((img: { url: string }) => ({
        url: img.url,
      }));

      // Prefill from product parameters
      const prefillValues: Record<string, string> = {};
      const productParams = product.parameters || [];
      for (const pp of productParams) {
        if (pp.values && pp.values.length > 0) {
          prefillValues[pp.id] = pp.values[0];
        } else if (pp.valuesIds && pp.valuesIds.length > 0) {
          prefillValues[pp.id] = pp.valuesIds[0];
        }
      }

      // Fetch category parameters separately — failure here must NOT discard the catalog result
      let parameters: Array<{
        id: string;
        name: string;
        type: string;
        required: boolean;
        unit: string | null;
        options: Array<{ id: string; name: string }>;
        restrictions: Record<string, unknown> | null;
      }> = [];

      if (categoryId) {
        try {
          const parametersData = await getCategoryParameters(categoryId);
          const allParams = parametersData.parameters || [];
          const requiredParams = allParams.filter(
            (p: { required: boolean }) => p.required === true
          );
          parameters = requiredParams.map(
            (p: {
              id: string;
              name: string;
              type: string;
              unit?: string;
              options?: Array<{ id: string; value: string }>;
              restrictions?: Record<string, unknown>;
            }) => ({
              id: p.id,
              name: p.name,
              type: p.type || "string",
              required: true,
              unit: p.unit || null,
              options: (p.options || []).map((opt) => ({
                id: opt.id,
                name: opt.value || opt.id,
              })),
              restrictions: p.restrictions || null,
            })
          );
        } catch (paramErr: unknown) {
          const e = paramErr as { response?: { status?: number }; message?: string };
          req.log.warn(
            { categoryId, status: e.response?.status, msg: e.message },
            "Could not fetch category parameters — returning Allegro product without required params"
          );
        }
      }

      res.json({
        productId,
        productName,
        categoryId,
        categoryName,
        images,
        parameters,
        prefillValues,
        source: "allegro_catalog",
      });
      return;
    }

    // ── Step 3: Fallback — use the multi-source external lookup chain ──
    req.log.info({ ean }, "Allegro catalog empty — trying external lookup");
    const result = await lookupEan(ean);

    if (!result.found) {
      res.status(404).json({
        error: "not_found",
        message: "Nie znaleziono produktu dla podanego kodu EAN",
        logs: result.logs,
      });
      return;
    }

    res.json({
      productId: null,
      productName: result.name,
      categoryId: null,
      categoryName: null,
      images: result.image ? [{ url: result.image }] : [],
      parameters: [],
      prefillValues: {},
      source: result.source,
      brand: result.brand,
      weight: result.weight,
      category: result.category,
      logs: result.logs,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error scanning EAN");
    res.status(500).json({
      error: "server_error",
      message: "Błąd podczas pobierania danych produktu",
    });
  }
});

router.post("/create-offer", async (req, res) => {
  try {
    const body = CreateOfferBody.parse(req.body);

    const offer = await createAllegroOffer(body);

    res.json({
      offerId: offer.id,
      status: offer.publication?.status || "INACTIVE",
      message: "Oferta została pomyślnie utworzona",
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error creating offer");
    const axiosErr = err as { response?: { data?: { errors?: Array<{ message: string }> }; status?: number } };
    if (axiosErr.response?.data?.errors) {
      res.status(400).json({
        error: "allegro_error",
        message:
          axiosErr.response.data.errors.map((e) => e.message).join(", ") ||
          "Błąd podczas tworzenia oferty",
      });
      return;
    }
    res.status(500).json({
      error: "server_error",
      message: "Błąd podczas tworzenia oferty na Allegro",
    });
  }
});

export default router;

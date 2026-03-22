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

const router: IRouter = Router();

router.get("/scan", async (req, res) => {
  try {
    const { ean } = ScanEanQueryParams.parse(req.query);

    const catalogData = await searchCatalogByEan(ean);

    const products = catalogData.products;
    if (!products || products.length === 0) {
      res.status(404).json({
        error: "not_found",
        message: "Nie znaleziono produktu dla podanego kodu EAN",
      });
      return;
    }

    const product = products[0];
    const categoryId = product.category?.id;
    const productId = product.id;
    const productName = product.name;
    const categoryName = product.category?.name || "";
    const images = (product.images || []).map((img: { url: string }) => ({
      url: img.url,
    }));

    const parametersData = await getCategoryParameters(categoryId);
    const allParams = parametersData.parameters || [];

    const requiredParams = allParams.filter(
      (p: { required: boolean }) => p.required === true
    );

    const prefillValues: Record<string, string> = {};
    const productParams = product.parameters || [];
    for (const pp of productParams) {
      if (pp.values && pp.values.length > 0) {
        prefillValues[pp.id] = pp.values[0];
      } else if (pp.valuesIds && pp.valuesIds.length > 0) {
        prefillValues[pp.id] = pp.valuesIds[0];
      }
    }

    const parameters = requiredParams.map(
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

    res.json({
      productId,
      productName,
      categoryId,
      categoryName,
      images,
      parameters,
      prefillValues,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error scanning EAN");
    const axiosErr = err as { response?: { data?: { errors?: Array<{ message: string }> }; status?: number } };
    if (axiosErr.response?.status === 404) {
      res.status(404).json({
        error: "not_found",
        message: "Nie znaleziono produktu dla podanego kodu EAN",
      });
      return;
    }
    if (axiosErr.response?.status === 403) {
      res.status(403).json({
        error: "access_denied",
        message: "Brak dostępu do katalogu produktów Allegro. Sprawdź uprawnienia aplikacji.",
      });
      return;
    }
    const errorDetails = axiosErr.response?.data?.errors?.map((e: { message: string }) => e.message).join(", ");
    res.status(500).json({
      error: "server_error",
      message: errorDetails || "Błąd podczas pobierania danych produktu",
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

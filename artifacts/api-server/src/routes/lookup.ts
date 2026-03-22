import { Router, type IRouter } from "express";
import { lookupEan } from "../lib/lookup";

const router: IRouter = Router();

router.get("/ping", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/lookup", async (req, res) => {
  const ean = String(req.query.ean || "").trim();
  if (!ean) {
    res.status(400).json({ error: "bad_request", message: "Parametr 'ean' jest wymagany" });
    return;
  }

  const result = await lookupEan(ean);
  res.json(result);
});

export default router;

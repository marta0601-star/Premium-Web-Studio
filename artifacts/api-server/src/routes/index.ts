import { Router, type IRouter } from "express";
import healthRouter from "./health";
import allegroRouter from "./allegro";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/allegro", allegroRouter);

export default router;

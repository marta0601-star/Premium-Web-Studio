import { Router, type IRouter } from "express";
import healthRouter from "./health";
import allegroRouter from "./allegro";
import lookupRouter from "./lookup";
import testRouter from "./test";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/allegro", allegroRouter);
router.use(lookupRouter);
router.use(testRouter);

export default router;

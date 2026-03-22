import { Router, type IRouter } from "express";
import healthRouter from "./health";
import allegroRouter from "./allegro";
import lookupRouter from "./lookup";
import testRouter from "./test";
import debugRouter from "./debug";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/allegro", allegroRouter);
router.use(lookupRouter);
router.use(testRouter);
router.use(debugRouter);
router.use(authRouter);

export default router;

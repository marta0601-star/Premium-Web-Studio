import { Router, type IRouter } from "express";
import healthRouter from "./health";
import allegroRouter from "./allegro";
import lookupRouter from "./lookup";
import testRouter from "./test";
import authRouter from "./auth";
import authLoginRouter from "./auth-login";
// debug routes disabled in production for security; re-enable via revert if needed.
// import debugRouter from "./debug";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/allegro", allegroRouter);
router.use(lookupRouter);
router.use(testRouter);
// router.use(debugRouter);
router.use(authRouter);
router.use(authLoginRouter);

export default router;

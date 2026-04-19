import { Router, type IRouter } from "express";
import healthRouter   from "./health.js";
import exchangeRouter from "./exchange.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(exchangeRouter);

export default router;

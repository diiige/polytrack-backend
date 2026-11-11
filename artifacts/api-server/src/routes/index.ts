import { Router, type IRouter } from "express";
import healthRouter from "./health";
import trackOfTheWeekRouter from "./track-of-the-week";
import leaderboardRouter from "./leaderboard";
import multiplayerRouter from "./multiplayer";

const router: IRouter = Router();

router.use(healthRouter);
// Register the read-only weekly map endpoint before stateful API routes.
router.use(trackOfTheWeekRouter);
router.use(leaderboardRouter);
router.use(multiplayerRouter);

export default router;

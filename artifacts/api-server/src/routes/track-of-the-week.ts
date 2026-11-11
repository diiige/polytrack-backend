import { GetTrackOfTheWeekResponse } from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import { getTrackOfTheWeek } from "../lib/track-of-the-week";

const router: IRouter = Router();
const supportedVersion = "0.6.3";

router.get("/v6/trackOfTheWeek", (req, res): void => {
  if (req.query.version !== supportedVersion) {
    res.status(400).json({ error: "Unsupported PolyTrack version" });
    return;
  }

  res.json(GetTrackOfTheWeekResponse.parse(getTrackOfTheWeek()));
});

export default router;
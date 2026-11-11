import { GetIceServersResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { Router, type IRouter } from "express";
import {
  createIceCredentialRateLimiter,
  createPostgresIceCredentialRateLimitStore,
  createConfiguredIceServers,
} from "../lib/ice-servers.js";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const supportedVersion = "0.6.0-beta2";
const iceCredentialRateLimitStore = createPostgresIceCredentialRateLimitStore({
  query: (statement, parameters) => pool.query(statement, parameters),
  onCleanupError: (error) => {
    logger.warn(
      { err: error },
      "Failed to clean up expired ICE credential rate-limit counters",
    );
  },
});
const getIceCredentialRetryAfter = createIceCredentialRateLimiter({
  store: iceCredentialRateLimitStore,
});

router.get("/v6/iceServers", async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  if (req.query.version !== supportedVersion) {
    res.status(400).json({ error: "Unsupported PolyTrack version" });
    return;
  }

  if (
    process.env.TURN_PROVIDER?.trim() ||
    process.env.TURN_URLS?.trim() ||
    process.env.TURN_SHARED_SECRET ||
    process.env.METERED_TURN_APP_NAME?.trim() ||
    process.env.METERED_TURN_API_KEY?.trim()
  ) {
    const retryAfterSeconds = await getIceCredentialRetryAfter(req.ip);
    if (retryAfterSeconds > 0) {
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "Too many ICE server requests" });
      return;
    }
  }

  try {
    const servers = await createConfiguredIceServers();
    res.json(GetIceServersResponse.parse(servers));
  } catch (error) {
    req.log.error({ err: error }, "Could not retrieve ICE servers");
    res.status(502).json({ error: "ICE server configuration is unavailable" });
  }
});

export default router;
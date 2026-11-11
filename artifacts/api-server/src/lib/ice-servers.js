import { createHash, createHmac, randomUUID } from "node:crypto";

const stunServer = {
  urls: [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
  ],
};

const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 60 * 60;
const MAX_TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
const METERED_OPEN_RELAY_STATIC_AUTH_SECRET = "openrelayprojectsecret";
const METERED_OPEN_RELAY_STATIC_AUTH_URLS = [
  "turn:staticauth.openrelay.metered.ca:80?transport=udp",
  "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
  "turn:staticauth.openrelay.metered.ca:443?transport=udp",
  "turns:staticauth.openrelay.metered.ca:443?transport=tcp",
];
const ICE_CREDENTIAL_REQUEST_LIMIT = 30;
const ICE_CREDENTIAL_REQUEST_WINDOW_MS = 60 * 1000;
const ICE_RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const ICE_RATE_LIMIT_COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESERVE_ICE_CREDENTIAL_REQUEST_SQL = `
  INSERT INTO ice_credential_rate_limits AS current_counter (
    client_key,
    window_started_at,
    request_count
  )
  VALUES ($1, statement_timestamp(), 1)
  ON CONFLICT (client_key) DO UPDATE SET
    window_started_at = CASE
      WHEN current_counter.window_started_at <= statement_timestamp()
        - ($2::double precision * INTERVAL '1 millisecond')
      THEN statement_timestamp()
      ELSE current_counter.window_started_at
    END,
    request_count = CASE
      WHEN current_counter.window_started_at <= statement_timestamp()
        - ($2::double precision * INTERVAL '1 millisecond')
      THEN 1
      ELSE LEAST(current_counter.request_count + 1, $3)
    END
  RETURNING
    request_count,
    GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        window_started_at
          + ($2::double precision * INTERVAL '1 millisecond')
          - statement_timestamp()
      )))
    )::integer AS retry_after_seconds
`;
const CLEANUP_ICE_CREDENTIAL_COUNTERS_SQL = `
  DELETE FROM ice_credential_rate_limits
  WHERE window_started_at <= statement_timestamp()
    - ($1::double precision * INTERVAL '1 millisecond')
`;

export function createIceCredentialRateLimiter({
  store,
  maxRequests = ICE_CREDENTIAL_REQUEST_LIMIT,
  windowMs = ICE_CREDENTIAL_REQUEST_WINDOW_MS,
} = {}) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("maxRequests must be a positive whole number");
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("windowMs must be a positive whole number");
  }
  if (!store || typeof store.consume !== "function") {
    throw new Error("A shared ICE credential rate-limit store is required");
  }

  return async (clientIp) => {
    const ip =
      typeof clientIp === "string" && clientIp.length > 0
        ? clientIp
        : "unknown";
    const clientKey = createHash("sha256").update(ip).digest("hex");
    const retryAfterSeconds = await store.consume(
      clientKey,
      maxRequests,
      windowMs,
    );

    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0) {
      throw new Error("ICE credential rate-limit store returned an invalid result");
    }
    return retryAfterSeconds;
  };
}

export function createPostgresIceCredentialRateLimitStore({
  query,
  onCleanupError = () => {
    console.warn("Failed to clean up expired ICE credential rate-limit counters");
  },
  now = Date.now,
} = {}) {
  if (typeof query !== "function") {
    throw new Error("A PostgreSQL query function is required");
  }

  let nextCleanupAt = 0;

  return {
    async consume(clientKey, maxRequests, windowMs) {
      const result = await query(RESERVE_ICE_CREDENTIAL_REQUEST_SQL, [
        clientKey,
        windowMs,
        maxRequests + 1,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new Error("PostgreSQL did not return an ICE rate-limit counter");
      }

      const requestCount = Number(row.request_count);
      const retryAfterSeconds = Number(row.retry_after_seconds);
      if (
        !Number.isSafeInteger(requestCount) ||
        requestCount < 1 ||
        !Number.isSafeInteger(retryAfterSeconds) ||
        retryAfterSeconds < 1
      ) {
        throw new Error("PostgreSQL returned an invalid ICE rate-limit counter");
      }

      const currentTime = now();
      if (currentTime >= nextCleanupAt) {
        nextCleanupAt = currentTime + ICE_RATE_LIMIT_CLEANUP_INTERVAL_MS;
        const retentionMs = Math.max(
          ICE_RATE_LIMIT_COUNTER_RETENTION_MS,
          windowMs * 2,
        );
        void query(CLEANUP_ICE_CREDENTIAL_COUNTERS_SQL, [retentionMs]).catch(
          onCleanupError,
        );
      }

      return requestCount > maxRequests ? retryAfterSeconds : 0;
    },
  };
}

function getTurnCredentialTtlSeconds(environment) {
  const configuredTtl = environment.TURN_CREDENTIAL_TTL_SECONDS;
  const configuredTtlIsWholeNumber =
    configuredTtl === undefined || /^\d+$/.test(configuredTtl);
  const ttlSeconds =
    configuredTtl === undefined
      ? DEFAULT_TURN_CREDENTIAL_TTL_SECONDS
      : Number(configuredTtl);
  if (
    !configuredTtlIsWholeNumber ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > MAX_TURN_CREDENTIAL_TTL_SECONDS
  ) {
    throw new Error(
      "TURN_CREDENTIAL_TTL_SECONDS must be a whole number from 60 to 86400",
    );
  }

  return ttlSeconds;
}

export function createIceServers(environment = process.env, now = Date.now()) {
  const turnUrlsValue = environment.TURN_URLS?.trim() ?? "";
  const sharedSecret = environment.TURN_SHARED_SECRET ?? "";

  if (!turnUrlsValue && !sharedSecret) {
    return [{ ...stunServer, urls: [...stunServer.urls] }];
  }

  if (!turnUrlsValue || !sharedSecret) {
    throw new Error("TURN_URLS and TURN_SHARED_SECRET must be configured together");
  }

  const turnUrls = turnUrlsValue.split(",").map((url) => url.trim());
  if (
    turnUrls.some((url) => !url || !/^turns?:/i.test(url)) ||
    new Set(turnUrls).size !== turnUrls.length
  ) {
    throw new Error("TURN_URLS must contain unique comma-separated TURN or TURNS URLs");
  }

  const ttlSeconds = getTurnCredentialTtlSeconds(environment);
  const username = `${Math.floor(now / 1000) + ttlSeconds}:${randomUUID()}`;
  const credential = createHmac("sha1", sharedSecret)
    .update(username)
    .digest("base64");

  return [
    { ...stunServer, urls: [...stunServer.urls] },
    {
      urls: turnUrls,
      username,
      credential,
      credentialType: "password",
    },
  ];
}

function isValidIceServer(server) {
  if (!server || typeof server !== "object") return false;
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    urls.some((url) => typeof url !== "string" || !/^(stun|stuns|turn|turns):/i.test(url))
  ) return false;
  const hasTurn = urls.some((url) => /^turns?:/i.test(url));
  return !hasTurn || (
    typeof server.username === "string" && server.username.length > 0 &&
    typeof server.credential === "string" && server.credential.length > 0
  );
}

function hasTurnServer(servers) {
  return servers.some((server) =>
    (typeof server.urls === "string" ? [server.urls] : server.urls)
      .some((url) => /^turns?:/i.test(url)),
  );
}

export async function createCloudflareIceServers(
  environment = process.env,
  fetchImpl = globalThis.fetch,
) {
  const keyId = environment.CLOUDFLARE_TURN_KEY_ID?.trim() ?? "";
  const token = environment.CLOUDFLARE_TURN_API_TOKEN?.trim() ?? "";
  if (!keyId || !token) {
    throw new Error("CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN must be configured together");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(keyId)) {
    throw new Error("CLOUDFLARE_TURN_KEY_ID is invalid");
  }

  const ttl = getTurnCredentialTtlSeconds(environment);
  let response;
  try {
    response = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(5000),
      },
    );
  } catch {
    // Do not propagate upstream errors that could contain request credentials.
    throw new Error("Could not contact Cloudflare TURN credential service");
  }
  if (!response.ok) {
    throw new Error(`Cloudflare TURN credential service returned HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare TURN credential service returned invalid JSON");
  }
  if (
    !Array.isArray(payload?.iceServers) ||
    !payload.iceServers.every(isValidIceServer) ||
    !hasTurnServer(payload.iceServers)
  ) {
    throw new Error("Cloudflare TURN credential service returned invalid ICE servers");
  }
  return payload.iceServers;
}

export async function createMeteredIceServers(
  environment = process.env,
  fetchImpl = globalThis.fetch,
) {
  const appName = environment.METERED_TURN_APP_NAME?.trim().toLowerCase() ?? "";
  const apiKey = environment.METERED_TURN_API_KEY?.trim() ?? "";
  if (!appName || !apiKey) {
    throw new Error("METERED_TURN_APP_NAME and METERED_TURN_API_KEY must be configured together");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appName)) {
    throw new Error("METERED_TURN_APP_NAME is invalid");
  }

  const credentialsUrl = new URL(
    `/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
    `https://${appName}.metered.live`,
  );

  let response;
  try {
    response = await fetchImpl(credentialsUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // The Metered API key is in the query string; never propagate fetch errors.
    throw new Error("Could not contact Metered Open Relay credential service");
  }
  if (!response.ok) {
    throw new Error(`Metered Open Relay credential service returned HTTP ${response.status}`);
  }

  let iceServers;
  try {
    iceServers = await response.json();
  } catch {
    throw new Error("Metered Open Relay credential service returned invalid JSON");
  }
  if (
    !Array.isArray(iceServers) ||
    !iceServers.every(isValidIceServer) ||
    !hasTurnServer(iceServers)
  ) {
    throw new Error("Metered Open Relay credential service returned invalid ICE servers");
  }
  return iceServers;
}

export function createMeteredOpenRelayIceServers(
  environment = process.env,
  now = Date.now(),
) {
  return createIceServers(
    {
      ...environment,
      TURN_URLS: METERED_OPEN_RELAY_STATIC_AUTH_URLS.join(","),
      TURN_SHARED_SECRET: METERED_OPEN_RELAY_STATIC_AUTH_SECRET,
    },
    now,
  );
}

export async function createConfiguredIceServers(
  environment = process.env,
  fetchImpl = globalThis.fetch,
) {
  const provider = environment.TURN_PROVIDER?.trim().toLowerCase() ?? "";
  if (provider === "cloudflare") {
    return createCloudflareIceServers(environment, fetchImpl);
  }
  if (provider === "metered") {
    return createMeteredIceServers(environment, fetchImpl);
  }
  if (provider === "openrelay") {
    return createMeteredOpenRelayIceServers(environment);
  }
  if (provider === "" || provider === "coturn") return createIceServers(environment);
  throw new Error("TURN_PROVIDER must be cloudflare, metered, openrelay, or coturn");
}
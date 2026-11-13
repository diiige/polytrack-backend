async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const trackId = url.searchParams.get("trackId") || "";
  const skip = parseInt(url.searchParams.get("skip") || "0", 10);
  const amount = parseInt(url.searchParams.get("amount") || "10", 10);
  const userTokenHash = url.searchParams.get("userTokenHash") || "";

  const result = await context.env.DB.prepare(
    `SELECT * FROM (
      SELECT CAST(id AS INTEGER) as id, user_token_hash as userId,
             COALESCE(nickname, 'Anonymous') as nickname,
             CAST(frames AS INTEGER) as frames,
             COALESCE(car_style, 'default') as carStyle,
             COALESCE(country_code, '') as countryCode,
             1 as verifiedState,
             ROW_NUMBER() OVER (PARTITION BY user_token_hash ORDER BY frames ASC) as rn
      FROM scores WHERE track_id = ?
    ) WHERE rn = 1
    ORDER BY frames ASC LIMIT ? OFFSET ?`
  ).bind(trackId, amount, skip).all();

  const entries = result.results.map(({ rn, ...entry }) => entry);

  const countResult = await context.env.DB.prepare(
    `SELECT COUNT(DISTINCT user_token_hash) as total FROM scores WHERE track_id = ?`
  ).bind(trackId).first();

  let userEntry = null;
  if (userTokenHash) {
    userEntry = await context.env.DB.prepare(
      `SELECT s.id as id, user_token_hash as userId,
              COALESCE(s.nickname, 'Anonymous') as nickname,
              CAST(s.frames AS INTEGER) as frames, s.recording,
              COALESCE(s.car_style, 'default') as carStyle,
              COALESCE(s.country_code, '') as countryCode,
              1 as verifiedState,
              (SELECT COUNT(*) FROM (
                 SELECT MIN(frames) as best FROM scores
                 WHERE track_id = ? GROUP BY user_token_hash
               ) AS ranked WHERE ranked.best < s.frames) + 1 as position
       FROM scores s WHERE s.track_id = ? AND s.user_token_hash = ?
       ORDER BY s.frames ASC LIMIT 1`
    ).bind(trackId, trackId, userTokenHash).first();
  }

  return Response.json({ 
    entries: entries,
    total: countResult?.total || 0,
    userEntry: userEntry
  });
}

export async function onRequestPost(context) {
  const formData = await context.request.formData();
  const userTokenHash = await sha256(formData.get("userToken"));
  const result = await context.env.DB.prepare(
    `INSERT INTO scores (user_token_hash, nickname, country_code, car_style, track_id, frames, recording, only_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userTokenHash,
    formData.get("nickname") || "Anonymous",
    formData.get("countryCode") || "",
    formData.get("carStyle") || "default",
    formData.get("trackId") || "",
    parseInt(formData.get("frames") || "0", 10),
    formData.get("recording") || "",
    formData.get("onlyVerified") === "true" ? 1 : 0
  ).run();
  return Response.json({ uploadId: result.meta.last_row_id });
}

export async function onRequestDelete(context) {
  const formData = await context.request.formData();
  const userTokenHash = await sha256(formData.get("userToken"));
  const result = await context.env.DB.prepare(
    `DELETE FROM scores WHERE user_token_hash = ? AND track_id = ?`
  ).bind(userTokenHash, formData.get("trackId") || "").run();
  return Response.json({ deletedRecords: result.meta.changes || 0 });
}

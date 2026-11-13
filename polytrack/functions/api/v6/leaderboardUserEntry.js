export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const result = await context.env.DB.prepare(
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
     FROM scores s
     WHERE s.track_id = ? AND s.user_token_hash = ?
     ORDER BY s.frames ASC LIMIT 1`
  ).bind(
    url.searchParams.get("trackId") || "",
    url.searchParams.get("trackId") || "",
    url.searchParams.get("userTokenHash") || ""
  ).first();

  return Response.json(result || null);
}

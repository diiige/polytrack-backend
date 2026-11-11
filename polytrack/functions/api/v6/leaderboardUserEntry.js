export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const result = await context.env.DB.prepare(
    `SELECT id, user_token_hash as userId, nickname, frames, recording, car_style, country_code
     FROM scores WHERE track_id = ? AND user_token_hash = ?
     ORDER BY frames ASC LIMIT 1`
  ).bind(
    url.searchParams.get("trackId") || "",
    url.searchParams.get("userTokenHash") || ""
  ).first();

  return Response.json(result || null);
}

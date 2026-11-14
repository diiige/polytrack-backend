// Returns stored replay recordings for the given leaderboard row ids, in request order.
// Entries that no longer exist are returned as null, matching the Replit API contract.
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const ids = (url.searchParams.get("ids") || "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);

  if (ids.length === 0) {
    return Response.json([]);
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await context.env.DB.prepare(
    `SELECT id, recording, frames, car_style FROM scores WHERE id IN (${placeholders})`
  ).bind(...ids).all();

  const byId = new Map(result.results.map((row) => [row.id, row]));
  return Response.json(
    ids.map((id) => {
      const row = byId.get(id);
      if (!row) return null;
      return {
        recording: row.recording || "",
        verifiedState: 0,
        frames: row.frames,
        carStyle: row.car_style || "default",
      };
    })
  );
}

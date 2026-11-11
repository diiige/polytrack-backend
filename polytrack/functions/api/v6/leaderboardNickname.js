async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost(context) {
  const formData = await context.request.formData();
  const userTokenHash = await sha256(formData.get("userToken"));

  const result = await context.env.DB.prepare(
    `UPDATE scores SET nickname = ? WHERE user_token_hash = ?`
  ).bind(formData.get("nickname") || "", userTokenHash).run();

  return Response.json({ updatedRecords: result.meta.changes || 0 });
}

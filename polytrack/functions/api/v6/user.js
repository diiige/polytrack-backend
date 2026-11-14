// The game posts here for account bookkeeping; no server-side state is kept.
export async function onRequestPost() {
  return new Response(null, { status: 204 });
}

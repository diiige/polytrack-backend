export async function onRequestGet(context) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 7);

  return Response.json({
    current: {
      trackId: "5159a8dac6a1f397407a7b5233ad570613531f6609f7dc897490c28c9f2c7a4e",
      name: "Apostle",
      author: "BonnieBeans",
      thumbnailUrl: "/main/tracks/community/thumbnails/apostle.png",
      endTime: end.toISOString(),
    },
    serverTime: now.toISOString(),
  });
}

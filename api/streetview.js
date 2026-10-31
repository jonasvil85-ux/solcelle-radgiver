// Vercel API route — proxyer Google Street View Static API
// Env: GOOGLE_SOLAR_KEY
module.exports = async function (req, res) {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).end();

  const key = process.env.GOOGLE_SOLAR_KEY;
  if (!key) return res.status(503).end();

  const url = `https://maps.googleapis.com/maps/api/streetview?size=640x320&location=${lat},${lon}&fov=90&pitch=5&source=outdoor&key=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();

    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.end(Buffer.from(buf));
  } catch (e) {
    return res.status(502).end();
  }
};

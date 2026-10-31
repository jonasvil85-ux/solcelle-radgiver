// Vercel API route — proxy til Datafordeleren BBR
// Env vars: DAF_USER (Bruger ID fra Datafordeler), DAF_TOKEN (API-nøgle)
module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.DAF_TOKEN;
  const user  = process.env.DAF_USER;
  if (!token) return res.status(503).json({ error: 'BBR_NOT_CONFIGURED' });

  const { lat, lon } = req.body || {};
  if (!lat || !lon) return res.status(400).json({ error: 'Mangler koordinater' });

  const DAF = 'https://services.datafordeler.dk';

  function authSuffix() {
    if (user) return `username=${encodeURIComponent(user)}&password=${encodeURIComponent(token)}`;
    return `token=${encodeURIComponent(token)}`;
  }

  async function dafFetch(path, params) {
    const url = `${DAF}${path}?${params}&${authSuffix()}&format=json`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    return r;
  }

  try {
    // Søg BBR bygning direkte via cirkelgeometri i WGS84
    // Datafordeler accepterer koordinatsystem=4326 for WGS84
    const bbrParams =
      `geometritype=CIRCLE` +
      `&geometri=POINT(${lon}%20${lat})` +
      `&radius=50` +
      `&koordinatsystem=4326` +
      `&MedtagNedlagteObjekter=false` +
      `&MaxAntalSvarPrRequest=1`;

    const bbrRes = await dafFetch('/BBR/BBRPublic/1/rest/bygning', bbrParams);

    if (!bbrRes.ok) {
      const txt = await bbrRes.text().catch(() => '');
      // Fallback: prøv uden koordinatsystem-parameter (bruger ETRS89 som default)
      if (bbrRes.status === 400 || bbrRes.status === 422) {
        return await fallbackEtrs89(res, lat, lon, dafFetch);
      }
      return res.status(502).json({ error: `BBR ${bbrRes.status}`, debug: txt.slice(0, 300) });
    }

    const bbrJson = await bbrRes.json();
    const bygninger = Array.isArray(bbrJson) ? bbrJson : (bbrJson?.results || []);

    if (!bygninger.length) {
      // Prøv med større radius
      const bbrRes2 = await dafFetch('/BBR/BBRPublic/1/rest/bygning',
        `geometritype=CIRCLE&geometri=POINT(${lon}%20${lat})&radius=150&koordinatsystem=4326&MedtagNedlagteObjekter=false&MaxAntalSvarPrRequest=1`);
      const bbrJson2 = bbrRes2.ok ? await bbrRes2.json() : [];
      const bygninger2 = Array.isArray(bbrJson2) ? bbrJson2 : (bbrJson2?.results || []);
      if (!bygninger2.length) {
        return res.status(404).json({ error: 'Bygning ikke fundet i BBR', lat, lon });
      }
      return formatBygning(res, bygninger2[0]);
    }

    return formatBygning(res, bygninger[0]);

  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};

async function fallbackEtrs89(res, lat, lon, dafFetch) {
  // Konverter WGS84 til ETRS89 UTM32N (approx)
  const { east, north } = wgs84ToEtrs89(parseFloat(lat), parseFloat(lon));
  const bbrParams =
    `geometritype=CIRCLE` +
    `&geometri=POINT(${east.toFixed(1)}%20${north.toFixed(1)})` +
    `&radius=50` +
    `&MedtagNedlagteObjekter=false` +
    `&MaxAntalSvarPrRequest=1`;
  const r = await dafFetch('/BBR/BBRPublic/1/rest/bygning', bbrParams);
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return res.status(502).json({ error: `BBR ETRS89 ${r.status}`, debug: txt.slice(0, 300) });
  }
  const j = await r.json();
  const bygninger = Array.isArray(j) ? j : (j?.results || []);
  if (!bygninger.length) return res.status(404).json({ error: 'Bygning ikke fundet i BBR (ETRS89 søgning)', lat, lon });
  return formatBygning(res, bygninger[0]);
}

function formatBygning(res, b) {
  return res.status(200).json({
    bebyggetAreal:   b.bebyggetAreal       ?? null,
    samletAreal:     b.samletBygningsareal ?? null,
    tagkonstruktion: b.tagkonstruktionKode ?? null,
    etager:          b.etager              ?? null,
    byggeaar:        b.byggear             ?? b.byggeaar ?? null,
    _raw: Object.keys(b),  // debug: hvilke felter returnerer BBR?
  });
}

// Approksimativ WGS84 → ETRS89 UTM zone 32N konvertering
function wgs84ToEtrs89(lat, lon) {
  const a = 6378137.0, f = 1 / 298.257222101;
  const k0 = 0.9996, lon0 = 9 * Math.PI / 180;
  const e2 = 2 * f - f * f;
  const e_p2 = e2 / (1 - e2);
  const phi = lat * Math.PI / 180;
  const lam = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = e_p2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lam - lon0);
  const e4 = e2 * e2, e6 = e4 * e2;
  const M = a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi));
  const east  = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * e_p2) * A ** 5 / 120) + 500000;
  const north = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * e_p2) * A ** 6 / 720));
  return { east, north };
}

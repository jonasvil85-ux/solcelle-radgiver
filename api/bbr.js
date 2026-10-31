// Vercel API route — proxy til Datafordeleren BBR
// Sæt DAF_TOKEN som Vercel environment variable (API-key fra Datafordeler Administration)
module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.DAF_TOKEN;
  if (!token) return res.status(503).json({ error: 'BBR_NOT_CONFIGURED' });

  const { lat, lon } = req.body || {};
  if (!lat || !lon) return res.status(400).json({ error: 'Mangler koordinater' });

  const DAF = 'https://services.datafordeler.dk';
  // Datafordeler API-key bruges som Bearer token
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  async function dafFetch(url) {
    // Prøv Bearer, fallback til token= query param
    let r = await fetch(url, { headers });
    if (r.status === 401) r = await fetch(url + (url.includes('?') ? '&' : '?') + `token=${token}`, { headers: { Accept: 'application/json' } });
    return r;
  }

  try {
    // Trin 1: Find husnummer-UUID fra koordinater via DAGADRESSEN
    const addrUrl = `${DAF}/DAGADRESSEN/DAGAdressen/1.0.0/REST/adresse` +
      `?geometritype=PUNKT&geometri=POINT(${lon}%20${lat})&maxAfstand=100&format=json`;
    const addrRes = await dafFetch(addrUrl);
    if (!addrRes.ok) {
      const txt = await addrRes.text().catch(() => '');
      return res.status(502).json({ error: `DAG ${addrRes.status}: ${txt.slice(0,200)}` });
    }
    const addrJson = await addrRes.json();
    const features = addrJson?.features || addrJson?.results || (Array.isArray(addrJson) ? addrJson : []);
    const feat = features[0]?.properties || features[0] || {};
    const adresseId = feat.id_lokalId || feat.Id_lokalId || feat.id || feat.adresseId || null;
    if (!adresseId) {
      return res.status(404).json({ error: 'Adresse ikke fundet', debug: JSON.stringify(addrJson).slice(0,400) });
    }

    // Trin 2: Find bygning i BBR via adresse-UUID
    const bbrUrl = `${DAF}/BBR/BBRPublic/1/rest/bygning` +
      `?adresseIdentificering=${adresseId}&format=json&MedtagNedlagteObjekter=false`;
    const bbrRes = await dafFetch(bbrUrl);
    if (!bbrRes.ok) {
      const txt = await bbrRes.text().catch(() => '');
      return res.status(502).json({ error: `BBR ${bbrRes.status}: ${txt.slice(0,200)}` });
    }
    const bbrJson = await bbrRes.json();
    const bygning = Array.isArray(bbrJson) ? bbrJson[0] : bbrJson?.results?.[0];
    if (!bygning) {
      return res.status(404).json({ error: 'Bygning ikke fundet i BBR', adresseId });
    }

    return res.status(200).json({
      bebyggetAreal:   bygning.bebyggetAreal       || null,
      samletAreal:     bygning.samletBygningsareal || null,
      tagkonstruktion: bygning.tagkonstruktionKode || null,
      etager:          bygning.etager              || null,
      byggeaar:        bygning.byggear             || null,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};

// Vercel API route — proxy til Datafordeleren BBR
// Kræver gratis servicebruger: https://datafordeler.dk/
// Sæt DAF_USER og DAF_PASS som Vercel environment variables
module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = process.env.DAF_USER;
  const pass = process.env.DAF_PASS;
  if (!user || !pass) return res.status(503).json({ error: 'BBR_NOT_CONFIGURED' });

  const { lat, lon } = req.body || {};
  if (!lat || !lon) return res.status(400).json({ error: 'Mangler koordinater' });

  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const DAF = 'https://services.datafordeler.dk';

  try {
    // Trin 1: Find adresse-UUID fra koordinater (DAG)
    const addrUrl = `${DAF}/DAGADRESSEN/DAGAdressen/1.0.0/REST/adresse` +
      `?geometritype=PUNKT&geometri=POINT(${lon}%20${lat})&maxAfstand=100&format=json`;
    const addrRes = await fetch(addrUrl, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!addrRes.ok) return res.status(502).json({ error: `DAG fejl: ${addrRes.status}` });
    const addrJson = await addrRes.json();

    // DAG returnerer GeoJSON FeatureCollection
    const features = addrJson?.features || addrJson?.results || [];
    const adresseId = features[0]?.properties?.id_lokalId
      || features[0]?.properties?.Id_lokalId
      || features[0]?.properties?.id;
    if (!adresseId) return res.status(404).json({ error: 'Adresse ikke fundet i DAG' });

    // Trin 2: Find bygning i BBR fra adresse-UUID
    const bbrUrl = `${DAF}/BBR/BBRPublic/1/rest/bygning` +
      `?adresseIdentificering=${adresseId}&format=json&MedtagNedlagteObjekter=false`;
    const bbrRes = await fetch(bbrUrl, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!bbrRes.ok) return res.status(502).json({ error: `BBR fejl: ${bbrRes.status}` });
    const bbrJson = await bbrRes.json();

    const bygning = Array.isArray(bbrJson) ? bbrJson[0] : bbrJson?.results?.[0];
    if (!bygning) return res.status(404).json({ error: 'Bygning ikke fundet i BBR' });

    return res.status(200).json({
      bebyggetAreal:      bygning.bebyggetAreal       || null, // fodaftryk m²
      samletAreal:        bygning.samletBygningsareal || null, // alle etager m²
      tagkonstruktion:    bygning.tagkonstruktionKode || null, // 1=fladt, 2=sadel, 3=halvvalm...
      etager:             bygning.etager              || null,
      byggeaar:           bygning.byggear             || null,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};

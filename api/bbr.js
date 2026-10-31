// Vercel API route — BBR via Datafordeler GraphQL
// Env: DAF_TOKEN (API-nøgle fra Datafordeler Administration)
// Kæde: DAR_Postnummer → DAR_Husnummer → BBR_Bygning
module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.DAF_TOKEN;
  if (!token) return res.status(503).json({ error: 'BBR_NOT_CONFIGURED' });

  const { road, houseNumber, postalCode } = req.body || {};
  if (!road || !houseNumber || !postalCode) {
    return res.status(400).json({ error: 'Mangler adressefelter (road, houseNumber, postalCode)' });
  }

  const DAR_GQL = `https://graphql.datafordeler.dk/DAR/v2/?apiKey=${token}`;
  const BBR_GQL = `https://graphql.datafordeler.dk/BBR/v3/?apiKey=${token}`;
  const now = new Date().toISOString().replace('Z', '+00:00');

  async function gql(endpoint, query) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} fra ${endpoint}`);
    return r.json();
  }

  try {
    // Trin 1: Find postnummer UUID
    const pData = await gql(DAR_GQL,
      `{ DAR_Postnummer(first:1, virkningstid:"${now}", where:{postnr:{eq:"${postalCode}"}}) { nodes { id_lokalId } } }`
    );
    const postnrUUID = pData?.data?.DAR_Postnummer?.nodes?.[0]?.id_lokalId;
    if (!postnrUUID) return res.status(404).json({ error: `Postnummer ${postalCode} ikke fundet i DAR` });

    // Trin 2: Find husnummer UUIDs (husnr + postnr → evt. flere kandidater)
    const hNum = houseNumber.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    const hData = await gql(DAR_GQL,
      `{ DAR_Husnummer(first:25, virkningstid:"${now}", where:{husnummertekst:{eq:"${hNum}"}, postnummer:{eq:"${postnrUUID}"}}) { nodes { id_lokalId } } }`
    );
    const husNodes = hData?.data?.DAR_Husnummer?.nodes || [];
    const husUUIDs = [...new Set(husNodes.map(n => n.id_lokalId))];
    if (!husUUIDs.length) return res.status(404).json({ error: `Husnummer ${hNum} ikke fundet i ${postalCode}` });

    // Trin 3: Query BBR for alle kandidater parallelt
    const bbrResults = await Promise.all(
      husUUIDs.slice(0, 10).map(uuid =>
        gql(BBR_GQL,
          `{ BBR_Bygning(first:1, virkningstid:"${now}", where:{husnummer:{eq:"${uuid}"}}) { nodes { id_lokalId byg041BebyggetAreal byg054AntalEtager } } }`
        ).then(d => d?.data?.BBR_Bygning?.nodes || []).catch(() => [])
      )
    );

    const buildings = bbrResults.flat().filter(b => b.byg041BebyggetAreal > 0);
    if (!buildings.length) return res.status(404).json({ error: 'Ingen BBR-bygning fundet for adressen' });

    // Vælg bedste match: foretruk areal 50-500 m² (parcelhus), ellers første
    const residential = buildings.filter(b => b.byg041BebyggetAreal >= 50 && b.byg041BebyggetAreal <= 500);
    const best = residential.length
      ? residential.reduce((a, b) =>
          Math.abs(a.byg041BebyggetAreal - 120) <= Math.abs(b.byg041BebyggetAreal - 120) ? a : b)
      : buildings[0];

    return res.status(200).json({
      bebyggetAreal:   best.byg041BebyggetAreal,
      etager:          best.byg054AntalEtager ?? null,
      samletAreal:     null,
      tagkonstruktion: null,
      byggeaar:        null,
    });

  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};

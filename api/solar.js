// Vercel API route — Google Solar API buildingInsights
// Env: GOOGLE_SOLAR_KEY
module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GOOGLE_SOLAR_KEY;
  if (!key) return res.status(503).json({ error: 'SOLAR_NOT_CONFIGURED' });

  const { lat, lon } = req.body || {};
  if (!lat || !lon) return res.status(400).json({ error: 'Mangler lat/lon' });

  try {
    const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lon}&requiredQuality=LOW&key=${key}`;
    const r = await fetch(url);

    if (r.status === 404) return res.status(404).json({ error: 'Ingen Solar-data for denne adresse' });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(r.status).json({ error: `Google Solar HTTP ${r.status}: ${txt.slice(0, 200)}` });
    }

    const data = await r.json();
    const segments = (data.solarPotential?.roofSegmentStats || []).map(s => ({
      azimuthDegrees: s.azimuthDegrees,
      pitchDegrees:   s.pitchDegrees,
      areaMeters2:    s.stats?.areaMeters2 ?? 0,
    }));

    return res.status(200).json({
      segments,
      maxPanels:       data.solarPotential?.maxArrayPanelsCount ?? null,
      maxAreaMeters2:  data.solarPotential?.maxArrayAreaMeters2 ?? null,
      sunshineHours:   data.solarPotential?.maxSunshineHoursPerYear ?? null,
      imageryQuality:  data.imageryQuality ?? null,
      imageryDate:     data.imageryDate ? `${data.imageryDate.year}-${String(data.imageryDate.month).padStart(2,'0')}-${String(data.imageryDate.day).padStart(2,'0')}` : null,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};

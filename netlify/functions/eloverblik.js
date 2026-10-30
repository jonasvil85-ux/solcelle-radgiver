exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { refreshToken } = JSON.parse(event.body || '{}');
    if (!refreshToken) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token mangler' }) };

    // 1. Exchange refresh token for short-lived data token
    const tokenRes = await fetch('https://api.eloverblik.dk/customerapi/api/token', {
      headers: { Authorization: `Bearer ${refreshToken}`, Accept: 'application/json' },
    });
    if (!tokenRes.ok) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Ugyldigt token — tjek at du kopierede det korrekt fra eloverblik.dk' }) };
    }
    const { result: { token: dataToken } } = await tokenRes.json();

    // 2. Get metering points
    const mpRes = await fetch('https://api.eloverblik.dk/customerapi/api/meteringpoints/meteringpoints', {
      headers: { Authorization: `Bearer ${dataToken}`, Accept: 'application/json' },
    });
    const mpData = await mpRes.json();
    const points = (mpData.result || []).filter(p => p.typeOfMP === 'E17');
    if (!points.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Ingen forbrugsmåler fundet på denne konto' }) };
    const meteringPointId = points[0].meteringPointId;

    // 3. Fetch last 13 months of hourly data
    const now = new Date();
    const from = new Date(now); from.setMonth(from.getMonth() - 13);
    const dateFrom = from.toISOString().split('T')[0];
    const dateTo = now.toISOString().split('T')[0];

    const tsRes = await fetch(
      `https://api.eloverblik.dk/customerapi/api/meterdata/gettimeseries/${dateFrom}/${dateTo}/Hour`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${dataToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ meteringPoints: { meteringPoint: [meteringPointId] } }),
      }
    );
    const tsData = await tsRes.json();

    const processed = processTimeSeries(tsData);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...processed }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Serverfejl: ' + err.message }) };
  }
};

function processTimeSeries(tsData) {
  const hourlyTotals = new Array(24).fill(0);
  const hourlyCounts = new Array(24).fill(0);
  const monthlyTotals = new Array(12).fill(0);
  let annualKwh = 0;

  try {
    const series = tsData.result[0].MyEnergyData_MarketDocument.TimeSeries;
    for (const s of series) {
      for (const period of s.Period) {
        const month = new Date(period.timeInterval.start).getMonth();
        for (const point of period.Point) {
          const hour = (parseInt(point.position) - 1) % 24;
          const kwh = parseFloat(point['out_Quantity.quantity'] ?? point['in_Quantity.quantity'] ?? 0);
          if (!isNaN(kwh) && kwh >= 0) {
            hourlyTotals[hour] += kwh;
            hourlyCounts[hour]++;
            monthlyTotals[month] += kwh;
            annualKwh += kwh;
          }
        }
      }
    }
  } catch (_) { /* return best-effort result */ }

  const hourlyProfile = hourlyTotals.map((t, h) =>
    hourlyCounts[h] > 0 ? +((t / hourlyCounts[h]).toFixed(3)) : 0
  );

  return {
    annualKwh: Math.round(annualKwh),
    hourlyProfile,
    monthlyProfile: monthlyTotals.map(Math.round),
  };
}

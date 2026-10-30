exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let refreshToken;
  try {
    const body = JSON.parse(event.body || '{}');
    refreshToken = body.refreshToken;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ugyldig forespørgsel: ' + e.message }) };
  }

  if (!refreshToken) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token mangler' }) };

  // 1. Exchange refresh token for short-lived data token
  let tokenRes;
  try {
    tokenRes = await fetch('https://api.eloverblik.dk/customerapi/api/token', {
      headers: { Authorization: `Bearer ${refreshToken}`, Accept: 'application/json' },
    });
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Kunne ikke forbinde til eloverblik.dk: ' + e.message }) };
  }

  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => '');
    return { statusCode: 401, headers, body: JSON.stringify({ error: `Ugyldigt token (${tokenRes.status}) — tjek at du kopierede det korrekt fra eloverblik.dk` }) };
  }

  let dataToken;
  try {
    const tokenText = await tokenRes.text();
    const tokenJson = JSON.parse(tokenText);
    // Log structure to debug
    const keys = Object.keys(tokenJson);
    const resultKeys = tokenJson.result ? Object.keys(tokenJson.result) : [];
    dataToken = tokenJson.result?.token ?? tokenJson.token ?? tokenJson.access_token;
    if (!dataToken) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Token-svar struktur: ${keys.join(',')} / result: ${resultKeys.join(',')} / preview: ${tokenText.slice(0,200)}` }) };
    }
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Uventet svar fra eloverblik.dk ved token-udveksling: ' + e.message }) };
  }

  // 2. Get metering points
  let mpData;
  try {
    const mpRes = await fetch('https://api.eloverblik.dk/customerapi/api/meteringpoints/meteringpoints', {
      headers: { Authorization: `Bearer ${dataToken}`, Accept: 'application/json' },
    });
    const mpText = await mpRes.text();
    if (!mpText || mpText.trim() === '') {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Tomt svar fra eloverblik.dk ved målepunkter (HTTP ' + mpRes.status + ')' }) };
    }
    mpData = JSON.parse(mpText);
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Kunne ikke hente målepunkter: ' + e.message }) };
  }

  const allPoints = mpData.result || [];
  // Try E17 (consumption) first, fall back to any point
  const points = allPoints.filter(p => p.typeOfMP === 'E17').length
    ? allPoints.filter(p => p.typeOfMP === 'E17')
    : allPoints;
  if (!points.length) return { statusCode: 404, headers, body: JSON.stringify({ error: `Ingen målepunkter fundet. API svarede: ${JSON.stringify(mpData).slice(0, 200)}` }) };
  const meteringPointId = points[0].meteringPointId;

  // 3. Fetch last 13 months of hourly data
  const now = new Date();
  const from = new Date(now); from.setMonth(from.getMonth() - 13);
  const dateFrom = from.toISOString().split('T')[0];
  const dateTo = now.toISOString().split('T')[0];

  let tsData;
  try {
    const tsRes = await fetch(
      `https://api.eloverblik.dk/customerapi/api/meterdata/gettimeseries/${dateFrom}/${dateTo}/Hour`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${dataToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ meteringPoints: { meteringPoint: [meteringPointId] } }),
      }
    );
    tsData = await tsRes.json();
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Kunne ikke hente forbrugsdata: ' + e.message }) };
  }

  const processed = processTimeSeries(tsData);
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...processed }) };
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
  } catch (_) { }

  const hourlyProfile = hourlyTotals.map((t, h) =>
    hourlyCounts[h] > 0 ? +((t / hourlyCounts[h]).toFixed(3)) : 0
  );

  return {
    annualKwh: Math.round(annualKwh),
    hourlyProfile,
    monthlyProfile: monthlyTotals.map(Math.round),
  };
}

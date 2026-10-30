exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let refreshToken, priceType, fixedPrice, spotSurcharge, zipcode;
  try {
    const body = JSON.parse(event.body || '{}');
    refreshToken  = body.refreshToken;
    priceType     = body.priceType || 'spot';
    fixedPrice    = parseFloat(body.fixedPrice) || 2.70;
    spotSurcharge = parseFloat(body.spotSurcharge) || 0;
    zipcode       = body.zipcode || '';
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
    await tokenRes.text().catch(() => '');
    return { statusCode: 401, headers, body: JSON.stringify({ error: `Ugyldigt token (${tokenRes.status}) — tjek at du kopierede det korrekt fra eloverblik.dk` }) };
  }

  let dataToken;
  try {
    const tokenJson = JSON.parse(await tokenRes.text());
    dataToken = typeof tokenJson.result === 'string'
      ? tokenJson.result
      : tokenJson.result?.token ?? tokenJson.token ?? tokenJson.access_token;
    if (!dataToken) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Kunne ikke udtrække data-token fra svar' }) };
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
  const points = allPoints.filter(p => p.typeOfMP === 'E17').length
    ? allPoints.filter(p => p.typeOfMP === 'E17')
    : allPoints;
  if (!points.length) return { statusCode: 404, headers, body: JSON.stringify({ error: `Ingen målepunkter fundet. API svarede: ${JSON.stringify(mpData).slice(0, 200)}` }) };
  const meteringPointId = points[0].meteringPointId;

  // 3. Fetch last 12 months of hourly data (exact 12 months = clean annual figure)
  const now = new Date();
  const from = new Date(now); from.setFullYear(from.getFullYear() - 1);
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

  // 4. Calculate effective electricity price
  let effectiveKwhPrice = fixedPrice;
  if (priceType === 'spot') {
    // Determine price zone from zip: DK2 = 1000-4999 (Sjælland/Øer), DK1 = rest
    const zipNum = parseInt(zipcode) || 0;
    const priceArea = (zipNum >= 1000 && zipNum <= 4999) ? 'DK2' : 'DK1';

    try {
      const spotUrl = `https://api.energidataservice.dk/dataset/Elspotprice?start=${dateFrom}T00:00&end=${dateTo}T23:59&filter=%7B%22PriceArea%22%3A%22${priceArea}%22%7D&columns=HourUTC,SpotPriceDKK&limit=20000`;
      const spotRes = await fetch(spotUrl, { headers: { Accept: 'application/json' } });
      const spotJson = await spotRes.json();
      const records = spotJson.records || [];

      // Build lookup: HourUTC string (truncated to hour) -> price in kr/kWh
      const spotMap = {};
      for (const r of records) {
        const key = r.HourUTC ? r.HourUTC.slice(0, 13) : null; // "2024-01-01T12"
        if (key && r.SpotPriceDKK != null) spotMap[key] = r.SpotPriceDKK / 1000; // DKK/MWh -> kr/kWh
      }

      // Match hourly consumption with spot prices
      let totalCost = 0, totalKwh = 0;
      try {
        const series = tsData.result[0].MyEnergyData_MarketDocument.TimeSeries;
        for (const s of series) {
          for (const period of s.Period) {
            const periodStart = new Date(period.timeInterval.start);
            for (const point of period.Point) {
              const pos = parseInt(point.position) - 1;
              const kwh = parseFloat(point['out_Quantity.quantity'] ?? point['in_Quantity.quantity'] ?? 0);
              if (isNaN(kwh) || kwh < 0) continue;
              const ts = new Date(periodStart.getTime() + pos * 3600000);
              const key = ts.toISOString().slice(0, 13); // "2024-01-01T12"
              const spotKr = spotMap[key];
              if (spotKr != null) {
                totalCost += kwh * spotKr;
                totalKwh  += kwh;
              }
            }
          }
        }
      } catch (_) {}

      if (totalKwh > 0) {
        const avgSpot = totalCost / totalKwh; // weighted avg spot kr/kWh (ex-moms)
        // actualSpotCost: PRÆCIS beregnet ud fra Eloverblik kWh × Energidataservice spotpris time for time
        // inkl. moms (25%) men UDEN nettarif og systemtarif
        const actualSpotCostInclMoms = Math.round(totalCost * 1.25);

        // Estimeret total: spot + nettarif (skøn, DSO-specifik) + systemtarif + moms
        // El-afgift: 0 kr/kWh i 2026 (afskaffet — vender tilbage 2028)
        // Nettarif: skønnet gennemsnit, DK1 (Jylland/Fyn) ~0.22, DK2 (Sjælland) ~0.28 kr/kWh ex moms
        const nettarif = priceArea === 'DK2' ? 0.28 : 0.22;
        const overhead = nettarif + 0.07; // systemtarif 0.07, ingen el-afgift i 2026
        effectiveKwhPrice = +((avgSpot + spotSurcharge + overhead) * 1.25).toFixed(3);

        processed.spotAvg = +avgSpot.toFixed(4);
        processed.priceArea = priceArea;
        processed.actualSpotCost = actualSpotCostInclMoms; // præcis spotudgift inkl. moms
        processed.calculatedAnnualCost = Math.round(processed.annualKwh * effectiveKwhPrice);
      }
    } catch (_) {
      // Fall back to default if Energidataservice fails
      effectiveKwhPrice = 2.70;
    }
  }

  processed.effectiveKwhPrice = effectiveKwhPrice;
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...processed }) };
};

function processTimeSeries(tsData) {
  const hourlyTotals = new Array(24).fill(0);
  const hourlyCounts = new Array(24).fill(0);
  const summerTotals = new Array(24).fill(0); // Apr-Sep (months 3-8)
  const summerCounts = new Array(24).fill(0);
  const winterTotals = new Array(24).fill(0); // Oct-Mar (months 9-2)
  const winterCounts = new Array(24).fill(0);
  const monthlyTotals = new Array(12).fill(0);
  let annualKwh = 0;

  try {
    const series = tsData.result[0].MyEnergyData_MarketDocument.TimeSeries;
    for (const s of series) {
      for (const period of s.Period) {
        const month = new Date(period.timeInterval.start).getMonth(); // 0=Jan
        const isSummer = month >= 3 && month <= 8;
        for (const point of period.Point) {
          const hour = (parseInt(point.position) - 1) % 24;
          const kwh = parseFloat(point['out_Quantity.quantity'] ?? point['in_Quantity.quantity'] ?? 0);
          if (!isNaN(kwh) && kwh >= 0) {
            hourlyTotals[hour] += kwh;
            hourlyCounts[hour]++;
            monthlyTotals[month] += kwh;
            annualKwh += kwh;
            if (isSummer) { summerTotals[hour] += kwh; summerCounts[hour]++; }
            else           { winterTotals[hour] += kwh; winterCounts[hour]++; }
          }
        }
      }
    }
  } catch (_) { }

  const avg = (totals, counts) => totals.map((t, h) =>
    counts[h] > 0 ? +((t / counts[h]).toFixed(3)) : 0
  );

  return {
    annualKwh: Math.round(annualKwh),
    hourlyProfile:       avg(hourlyTotals, hourlyCounts),
    summerHourlyProfile: avg(summerTotals, summerCounts),
    winterHourlyProfile: avg(winterTotals, winterCounts),
    monthlyProfile: monthlyTotals.map(Math.round),
  };
}

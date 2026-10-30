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

  // Extract DSO GLN from metering point (multiple possible field names)
  const mpPoint = points[0];
  const dsoGLNFromMP = mpPoint.gridCompanyGLNNumber || mpPoint.gridOperatorGLN
    || mpPoint.gridAreaGLN || mpPoint.gridCompanyGLN || null;

  // 3. Fetch last 12 months of hourly data
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
    const zipNum = parseInt(zipcode) || 0;
    const priceArea = (zipNum >= 1000 && zipNum <= 4999) ? 'DK2' : 'DK1';

    // DSO GLN: from metering point data, or zip-code fallback for major Danish DSOs
    const dsoGLN = dsoGLNFromMP || zipToGLN(zipNum);

    try {
      // Fetch spot prices and nettarif in parallel
      const [spotRes, nettarifRes] = await Promise.all([
        fetch(
          `https://api.energidataservice.dk/dataset/Elspotprice?start=${dateFrom}T00:00&end=${dateTo}T23:59` +
          `&filter=%7B%22PriceArea%22%3A%22${priceArea}%22%7D&columns=HourUTC,SpotPriceDKK&limit=20000`,
          { headers: { Accept: 'application/json' } }
        ),
        fetch(
          `https://api.energidataservice.dk/dataset/DatahubPricelist` +
          `?filter=%7B%22GLN_Number%22%3A%22${dsoGLN}%22%2C%22ChargeType%22%3A%22D03%22%2C%22ChargeTypeCode%22%3A%22CD%22%7D` +
          `&columns=ValidFrom,ValidTo,Price1,Price2,Price3,Price4,Price5,Price6,Price7,Price8,Price9,Price10,Price11,Price12,Price13,Price14,Price15,Price16,Price17,Price18,Price19,Price20,Price21,Price22,Price23,Price24` +
          `&limit=50`,
          { headers: { Accept: 'application/json' } }
        ),
      ]);

      const [spotJson, nettarifJson] = await Promise.all([spotRes.json(), nettarifRes.json()]);
      const spotRecords = spotJson.records || [];
      const nettarifRecords = nettarifJson.records || [];

      // Spot lookup: HourUTC prefix → kr/kWh ex-moms
      const spotMap = {};
      for (const r of spotRecords) {
        const key = r.HourUTC ? r.HourUTC.slice(0, 13) : null;
        if (key && r.SpotPriceDKK != null) spotMap[key] = r.SpotPriceDKK / 1000;
      }

      // Nettarif lookup: given UTC Date → kr/kWh ex-moms
      // Price columns are in Danish local time (CET/CEST)
      function getNettarif(utcDate) {
        const month = utcDate.getUTCMonth(); // 0=Jan
        const isDST = month >= 2 && month <= 9; // approx Mar–Oct = CEST
        const localHour = (utcDate.getUTCHours() + (isDST ? 2 : 1)) % 24;
        const dateStr = utcDate.toISOString().split('T')[0];
        for (const rec of nettarifRecords) {
          const vf = rec.ValidFrom ? rec.ValidFrom.slice(0, 10) : '2000-01-01';
          const vt = rec.ValidTo   ? rec.ValidTo.slice(0, 10)   : '2099-12-31';
          if (dateStr >= vf && dateStr < vt) {
            return rec[`Price${localHour + 1}`] || 0;
          }
        }
        return 0;
      }

      // Systemtarif: Energinet (national, 2026) — could also fetch from DatahubPricelist
      // GLN 5790000432752 = Energinet, but for simplicity use known 2026 rate
      const SYSTEMTARIF = 0.061; // kr/kWh ex-moms (Energinet 2026 Q1-Q4 gennemsnit)

      // Match consumption with spot + nettarif hour by hour
      let totalSpotCost = 0, totalNettarifCost = 0, totalKwh = 0;
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
              const key = ts.toISOString().slice(0, 13);
              const spotKr = spotMap[key];
              if (spotKr != null) {
                totalSpotCost     += kwh * spotKr;
                totalNettarifCost += kwh * getNettarif(ts);
                totalKwh          += kwh;
              }
            }
          }
        }
      } catch (_) {}

      if (totalKwh > 0) {
        const avgSpot     = totalSpotCost / totalKwh;
        const avgNettarif = totalNettarifCost / totalKwh;

        // Præcis beregnet: spot + nettarif (begge time-for-time fra reelle data) + systemtarif + moms
        // El-afgift = 0 kr/kWh i 2026 (afskaffet, vender tilbage 2028)
        effectiveKwhPrice = +((avgSpot + spotSurcharge + avgNettarif + SYSTEMTARIF) * 1.25).toFixed(3);

        processed.spotAvg         = +avgSpot.toFixed(4);
        processed.nettarifAvg     = +avgNettarif.toFixed(4);
        processed.priceArea       = priceArea;
        processed.dsoGLN          = dsoGLN;
        processed.actualSpotCost  = Math.round(totalSpotCost * 1.25);         // præcis spotudgift inkl. moms
        processed.actualNettarif  = Math.round(totalNettarifCost * 1.25);     // præcis nettarif inkl. moms
        processed.calculatedAnnualCost = Math.round(processed.annualKwh * effectiveKwhPrice);
      }
    } catch (_) {
      effectiveKwhPrice = 2.70;
    }
  }

  processed.effectiveKwhPrice = effectiveKwhPrice;
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...processed }) };
};

// Map zip code to DSO GLN for major Danish grid operators
function zipToGLN(zip) {
  if (zip >= 9000) return '5790001089030'; // N1 (Nordjylland)
  if (zip >= 7900) return '5790001089030'; // N1 (parts of 8xxx/Randers etc.)
  if (zip >= 7000) return '5790001091005'; // TREFOR Energi Net (Trekantområdet)
  if (zip >= 6000) return '5790001091005'; // TREFOR / Sydjylland
  if (zip >= 5000) return '5790001089006'; // Cerius (Fyn/Langeland)
  if (zip >= 4000) return '5790001089006'; // Cerius (Sjælland syd)
  if (zip >= 3000) return '5790000705689'; // Radius (Nordsjælland)
  if (zip >= 2000) return '5790000705689'; // Radius (Storkøbenhavn)
  if (zip >= 1000) return '5790000705689'; // Radius (København)
  return '5790000705689'; // Radius fallback
}

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

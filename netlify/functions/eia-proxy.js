exports.handler = async function(event, context) {
  const key = process.env.EIA_API_KEY;
  if (!key) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'EIA key not configured on server' }),
    };
  }

  const url =
    'https://api.eia.gov/v2/petroleum/pri/gnd/data/' +
    `?api_key=${key}` +
    '&frequency=weekly&data[0]=value' +
    '&facets[product][]=EPM0&facets[duoarea][]=NUS' +
    '&sort[0][column]=period&sort[0][direction]=desc&length=8';

  try {
    const res  = await fetch(url);
    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `EIA returned HTTP ${res.status}` }),
      };
    }
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'EIA fetch failed', detail: err.message }),
    };
  }
};

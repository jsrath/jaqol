const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 9104;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 1000 * 60 * 60);
const MUSE_API = 'https://www.themuse.com/api/public/jobs';
const NUMBEO_US_RANKINGS = 'https://www.numbeo.com/quality-of-life/region_rankings.jsp?region=019&title=2024';
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;
const NUMBEO_DELAY_MS = 400;

const cities = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf8')).cities;
let cache = { fetchedAt: 0, payload: null };

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function numbeoKey(city, state) {
  return `${city}, ${state}, United States`;
}

function citySlugs(city, state) {
  const specialSlugs = {
    'St. Louis': ['Saint-Louis'],
    Washington: ['Washington'],
  };

  const base = city.replace(/\./g, '').replace(/'/g, '').trim().replace(/\s+/g, '-');
  return [...new Set([...(specialSlugs[city] || []), base, `${base}-${state}`])];
}

function parseQualityScore(html) {
  const match = html.match(/Quality of Life Index: <\/td>\s*<td style="text-align: right">\s*([0-9.]+)/);
  return match ? Number(match[1]) : null;
}

async function fetchRegionalQualityScores() {
  const response = await fetch(NUMBEO_US_RANKINGS);
  if (!response.ok) {
    throw new Error(`Numbeo rankings request failed (${response.status})`);
  }

  const html = await response.text();
  const rows = [...html.matchAll(/\[\s*(-?[0-9.]+),\s*(-?[0-9.]+),\s*"([^"]+)",\s*([0-9.]+)\s*\]/g)];

  return Object.fromEntries(rows.map(match => [match[3], Number(match[4])]));
}

async function fetchCityQualityScore(city, state, regionalScores) {
  const key = numbeoKey(city, state);
  if (regionalScores[key]) {
    return regionalScores[key];
  }

  for (const slug of citySlugs(city, state)) {
    const response = await fetch(`https://www.numbeo.com/quality-of-life/in/${encodeURIComponent(slug)}`);
    if (!response.ok) {
      continue;
    }

    const score = parseQualityScore(await response.text());
    if (score) {
      return score;
    }

    await wait(NUMBEO_DELAY_MS);
  }

  return null;
}

async function fetchJobCount(city, state) {
  const location = encodeURIComponent(`${city}, ${state}`);
  const category = encodeURIComponent('Software Engineering');
  const url = `${MUSE_API}?location=${location}&category=${category}&desc=frontend&page=1`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`The Muse API returned ${response.status} for ${city}, ${state}`);
  }

  const payload = await response.json();
  return payload.total || 0;
}

async function buildCityData() {
  const regionalScores = await fetchRegionalQualityScores();
  const data = [];

  for (let index = 0; index < cities.length; index += BATCH_SIZE) {
    const batch = cities.slice(index, index + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async city => {
        const [jobs, qualityOfLife] = await Promise.all([
          fetchJobCount(city.city, city.state),
          fetchCityQualityScore(city.city, city.state, regionalScores),
        ]);

        return {
          ...city,
          jobs,
          qualityOfLife,
        };
      }),
    );

    data.push(...batchResults);

    if (index + BATCH_SIZE < cities.length) {
      await wait(BATCH_DELAY_MS);
    }
  }

  return {
    data,
    sources: {
      jobs: 'The Muse Jobs API',
      qualityOfLife: 'Numbeo Quality of Life Index',
    },
    jobsQuery: 'Software Engineering + frontend, by city',
    fetchedAt: new Date().toISOString(),
  };
}

app.use(express.static(__dirname));

app.get('/api/cities', async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const cacheIsFresh = cache.payload && Date.now() - cache.fetchedAt < CACHE_TTL_MS;

  if (!forceRefresh && cacheIsFresh) {
    return res.json(cache.payload);
  }

  try {
    const payload = await buildCityData();
    cache = { fetchedAt: Date.now(), payload };
    return res.json(payload);
  } catch (error) {
    console.error(error);

    if (cache.payload) {
      return res.json({
        ...cache.payload,
        stale: true,
        warning: 'Serving cached city data because a live data request failed.',
      });
    }

    return res.status(502).json({ error: 'Unable to fetch live city data.' });
  }
});

// Backward-compatible alias while developing locally.
app.get('/api/jobs', (req, res) => {
  req.url = `/api/cities${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  app.handle(req, res);
});

app.listen(port, () => {
  console.log(`Jaqol running at http://127.0.0.1:${port}`);
});

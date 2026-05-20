const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 9104;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 1000 * 60 * 60);
const MUSE_API = 'https://www.themuse.com/api/public/jobs';
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;

const cities = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf8')).cities;
const snapshotPath = path.join(__dirname, 'data', 'cities-snapshot.json');

function loadSnapshotFromDisk() {
  if (!fs.existsSync(snapshotPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

const snapshotPayload = loadSnapshotFromDisk();
let cache = {
  fetchedAt: snapshotPayload ? Date.now() : 0,
  payload: snapshotPayload,
};
let refreshInFlight = null;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function refreshJobCounts(basePayload) {
  const data = [];

  for (let index = 0; index < cities.length; index += BATCH_SIZE) {
    const batch = cities.slice(index, index + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async city => {
        const existing = basePayload.data.find(
          row => row.city === city.city && row.state === city.state,
        );
        const jobs = await fetchJobCount(city.city, city.state);

        return {
          ...city,
          jobs,
          qualityOfLife: existing?.qualityOfLife ?? null,
        };
      }),
    );

    data.push(...batchResults);

    if (index + BATCH_SIZE < cities.length) {
      await wait(BATCH_DELAY_MS);
    }
  }

  return {
    ...basePayload,
    data,
    fetchedAt: new Date().toISOString(),
    jobsRefreshedAt: new Date().toISOString(),
  };
}

function respondWithPayload(res, payload, extras = {}) {
  return res.json({ ...payload, ...extras });
}

function scheduleBackgroundRefresh() {
  if (refreshInFlight || !cache.payload) {
    return refreshInFlight;
  }

  refreshInFlight = refreshJobCounts(cache.payload)
    .then(payload => {
      cache = { fetchedAt: Date.now(), payload };
      return payload;
    })
    .catch(error => {
      console.error('Background job refresh failed:', error.message);
      return null;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

app.use(express.static(__dirname));

app.get('/api/cities', async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const cacheIsFresh = cache.payload && Date.now() - cache.fetchedAt < CACHE_TTL_MS;

  if (!cache.payload) {
    return res.status(503).json({
      error: 'City snapshot is not available. Run npm run build:snapshot and redeploy.',
    });
  }

  if (!forceRefresh && cacheIsFresh) {
    return respondWithPayload(res, cache.payload);
  }

  if (!forceRefresh) {
    scheduleBackgroundRefresh();
    return respondWithPayload(res, cache.payload, {
      stale: true,
      warning: 'Serving bundled city data while refreshing job counts in the background.',
    });
  }

  try {
    const payload = await refreshJobCounts(cache.payload);
    cache = { fetchedAt: Date.now(), payload };
    return respondWithPayload(res, payload);
  } catch (error) {
    console.error(error);
    return respondWithPayload(res, cache.payload, {
      stale: true,
      warning: 'Serving bundled city data because a job refresh failed.',
    });
  }
});

app.get('/api/jobs', (req, res) => {
  req.url = `/api/cities${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  app.handle(req, res);
});

app.listen(port, () => {
  if (snapshotPayload) {
    console.log(`Loaded bundled snapshot (${snapshotPayload.data.length} cities)`);
  } else {
    console.warn('No data/cities-snapshot.json found');
  }
  console.log(`Jaqol running at http://127.0.0.1:${port}`);
});

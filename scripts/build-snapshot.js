#!/usr/bin/env node
/**
 * Builds data/cities-snapshot.json using:
 * - The Muse Jobs API (live job counts)
 * - Numbeo QoL via Internet Archive (live Numbeo blocks server/datacenter IPs)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'cities.json'), 'utf8')).cities;
const MUSE_API = 'https://www.themuse.com/api/public/jobs';
const DEFAULT_WAYBACK_TIMESTAMP = '20240213190253';
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 400;
const WAYBACK_DELAY_MS = 1200;
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; JAQOL/1.0; +https://jaqol.onrender.com)',
  Accept: 'text/html,application/json',
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function numbeoKey(city, state) {
  return `${city}, ${state}, United States`;
}

function citySlugs(city, state) {
  const specialSlugs = {
    'St. Louis': ['Saint-Louis', 'St-Louis'],
    Washington: ['Washington'],
    'Kansas City': ['Kansas-City', 'Kansas-City-MO'],
    'Virginia Beach': ['Virginia-Beach'],
    'Ann Arbor': ['Ann-Arbor', 'Ann-Arbor-MI'],
    'Salt Lake City': ['Salt-Lake-City'],
    Orem: ['Orem', 'Orem-UT'],
  };

  const base = city.replace(/\./g, '').replace(/'/g, '').trim().replace(/\s+/g, '-');
  return [...new Set([...(specialSlugs[city] || []), base, `${base}-${state}`])];
}

function parseQualityScore(html) {
  const match = html.match(/Quality of Life Index: <\/td>\s*<td style="text-align: right">\s*([0-9.]+)/);
  return match ? Number(match[1]) : null;
}

async function fetchHtml(url) {
  const response = await fetch(url, { headers: FETCH_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchWaybackHtml(timestamp, numbeoPath) {
  return fetchHtml(`https://web.archive.org/web/${timestamp}/${numbeoPath}`);
}

async function listWaybackSnapshots(numbeoPath) {
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(numbeoPath)}&output=json&limit=12&filter=statuscode:200`;
  const response = await fetch(cdxUrl, { headers: FETCH_HEADERS });
  if (!response.ok) {
    throw new Error(`CDX search failed (${response.status})`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length < 2) {
    return [];
  }
  return rows.slice(1).map(row => row[1]);
}

async function fetchRegionalQualityScores() {
  const html = await fetchWaybackHtml(
    DEFAULT_WAYBACK_TIMESTAMP,
    'https://www.numbeo.com/quality-of-life/region_rankings.jsp?region=019&title=2024',
  );
  const rows = [...html.matchAll(/\[\s*(-?[0-9.]+),\s*(-?[0-9.]+),\s*"([^"]+)",\s*([0-9.]+)\s*\]/g)];
  const scores = Object.fromEntries(rows.map(match => [match[3], Number(match[4])]));
  if (!Object.keys(scores).length) {
    throw new Error('No QoL rows parsed from archived Numbeo rankings');
  }
  return scores;
}

async function fetchCityQualityScore(city, state) {
  const slugs = citySlugs(city, state);

  for (const slug of slugs) {
    const numbeoPath = `https://www.numbeo.com/quality-of-life/in/${encodeURIComponent(slug)}`;

    try {
      const html = await fetchWaybackHtml(DEFAULT_WAYBACK_TIMESTAMP, numbeoPath);
      const score = parseQualityScore(html);
      if (score) {
        return { score, source: `Numbeo via Wayback (${DEFAULT_WAYBACK_TIMESTAMP})` };
      }
    } catch {
      /* try CDX */
    }

    await wait(WAYBACK_DELAY_MS);

    let snapshots = [];
    try {
      snapshots = await listWaybackSnapshots(numbeoPath);
    } catch (error) {
      console.warn(`  CDX: ${city}, ${state} (${slug}): ${error.message}`);
      continue;
    }

    for (const timestamp of snapshots) {
      try {
        const html = await fetchWaybackHtml(timestamp, numbeoPath);
        const score = parseQualityScore(html);
        if (score) {
          return { score, source: `Numbeo via Wayback (${timestamp})` };
        }
      } catch {
        /* next snapshot */
      }
      await wait(WAYBACK_DELAY_MS);
    }
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

async function main() {
  console.log('Loading Numbeo US rankings from Internet Archive...');
  const regionalScores = await fetchRegionalQualityScores();
  console.log(`  ${Object.keys(regionalScores).length} cities in rankings table`);

  const data = [];
  for (let index = 0; index < cities.length; index += BATCH_SIZE) {
    const batch = cities.slice(index, index + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async city => {
        const jobs = await fetchJobCount(city.city, city.state);
        let qualityOfLife = regionalScores[numbeoKey(city.city, city.state)] ?? null;

        if (qualityOfLife == null) {
          console.log(`  Looking up archived Numbeo QoL for ${city.city}, ${city.state}...`);
          const result = await fetchCityQualityScore(city.city, city.state);
          qualityOfLife = result?.score ?? null;
        }

        return { ...city, jobs, qualityOfLife };
      }),
    );
    data.push(...batchResults);
    console.log(`Processed ${Math.min(index + BATCH_SIZE, cities.length)}/${cities.length}`);
    if (index + BATCH_SIZE < cities.length) {
      await wait(BATCH_DELAY_MS);
    }
  }

  const withQoL = data.filter(c => c.qualityOfLife != null).length;
  const missing = data.filter(c => c.qualityOfLife == null).map(c => `${c.city}, ${c.state}`);
  if (missing.length) {
    console.error('Missing QoL for:', missing.join('; '));
    process.exit(1);
  }

  const payload = {
    data,
    sources: {
      jobs: 'The Muse Jobs API',
      qualityOfLife: 'Numbeo Quality of Life Index (Internet Archive snapshots)',
    },
    jobsQuery: 'Software Engineering + frontend, by city',
    fetchedAt: new Date().toISOString(),
    snapshot: true,
  };

  const outPath = path.join(ROOT, 'data', 'cities-snapshot.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${outPath} (${withQoL}/${data.length} cities with QoL)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

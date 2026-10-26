// Loads the six S0 manual-data JSON files at runtime (browser fetch).
// Fail-noisy: a missing/broken file logs console.error naming it and throws.
const NAMES = ['weapons', 'accessories', 'economy', 'physics-presets', 'play-options', 'ai-personalities'];

export async function loadData(name) {
  const url = new URL(`data/${name}.json`, document.baseURI).href;
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    console.error(`[se/data] fetch failed for ${name}.json (${url}): ${err}`);
    throw err;
  }
  if (!res.ok) {
    console.error(`[se/data] missing data file ${name}.json (${url}): HTTP ${res.status}`);
    throw new Error(`missing data file: ${name}.json`);
  }
  return res.json();
}

export async function loadAll() {
  const out = {};
  for (const n of NAMES) out[n] = await loadData(n);
  return out;
}

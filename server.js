require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));

// ---- Helpers ---------------------------------------------------------------

// Open-Meteo's geocoder rarely has rivers themselves as entries, and often
// returns nothing for "<River name> River, <State>". Try a short ladder of
// simplified variants (dropping the watercourse word, dropping the state)
// before giving up - a nearby town/park/dam named after the river is a much
// better weather proxy than nothing at all.
function buildGeocodeCandidates(query) {
  const trimmed = query.trim();
  const candidates = [trimmed];

  const withoutWaterword = trimmed.replace(/\b(river|creek|fork|stream|brook)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (withoutWaterword && withoutWaterword !== trimmed) candidates.push(withoutWaterword);

  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const placeOnly = parts[0].replace(/\b(river|creek|fork|stream|brook)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (placeOnly) candidates.push([placeOnly, ...parts.slice(1)].join(', '));
    candidates.push(parts[parts.length - 1]);
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function geocodeQuery(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return (data && data.results && data.results[0]) || null;
}

async function geocodeLocation(query) {
  if (!query || !query.trim()) return { resolved: false };
  try {
    for (const candidate of buildGeocodeCandidates(query)) {
      const hit = await geocodeQuery(candidate);
      if (hit) {
        return {
          resolved: true,
          name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
          latitude: hit.latitude,
          longitude: hit.longitude,
          timezone: hit.timezone,
        };
      }
    }
    return { resolved: false };
  } catch (err) {
    console.error('Geocoding failed:', err.message);
    return { resolved: false };
  }
}

const DAILY_FIELDS = 'temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,cloudcover_mean';

async function fetchWeather(location, dateStr) {
  if (!location || !location.resolved || !dateStr) {
    return { available: false, note: 'Location not resolved, so weather could not be fetched.' };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));

  try {
    if (diffDays < 0) {
      // Past date -> historical archive.
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${location.latitude}&longitude=${location.longitude}&start_date=${dateStr}&end_date=${dateStr}&daily=${DAILY_FIELDS}&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`archive API status ${res.status}`);
      const data = await res.json();
      return summarizeDaily(data, 'Historical actuals for this date.');
    }

    if (diffDays <= 15) {
      // Today or near-future -> forecast API.
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&start_date=${dateStr}&end_date=${dateStr}&daily=${DAILY_FIELDS}&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`forecast API status ${res.status}`);
      const data = await res.json();
      return summarizeDaily(data, 'Weather forecast for this date.');
    }

    // Far future -> approximate using the same calendar date from last year as a "typical conditions" proxy.
    const lastYear = new Date(targetDate);
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    const lastYearStr = lastYear.toISOString().slice(0, 10);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${location.latitude}&longitude=${location.longitude}&start_date=${lastYearStr}&end_date=${lastYearStr}&daily=${DAILY_FIELDS}&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`archive API status ${res.status}`);
    const data = await res.json();
    return summarizeDaily(data, `Date is too far out for a forecast, so this is a typical-conditions estimate based on ${lastYearStr} (same date last year).`);
  } catch (err) {
    console.error('Weather fetch failed:', err.message);
    return { available: false, note: 'Weather lookup failed; reasoning will fall back to general seasonal expectations.' };
  }
}

function summarizeDaily(data, note) {
  const d = data && data.daily;
  if (!d || !d.time || d.time.length === 0) {
    return { available: false, note: 'No weather data returned; reasoning will fall back to general seasonal expectations.' };
  }
  return {
    available: true,
    note,
    date: d.time[0],
    tempMaxC: d.temperature_2m_max ? d.temperature_2m_max[0] : null,
    tempMinC: d.temperature_2m_min ? d.temperature_2m_min[0] : null,
    precipitationMm: d.precipitation_sum ? d.precipitation_sum[0] : null,
    windSpeedMaxKmh: d.windspeed_10m_max ? d.windspeed_10m_max[0] : null,
    cloudCoverPercent: d.cloudcover_mean ? d.cloudcover_mean[0] : null,
  };
}

// JSON schema enforced via Gemini's response_format, so the model's output
// is guaranteed to parse - no more fragile "please only output JSON" prompting.
const RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    identifiedFlies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', description: 'dry, nymph, emerger, streamer, wet, terrestrial, or other' },
          sizeHint: { type: 'string' },
          colorNotes: { type: 'string' },
          confidence: { type: 'number' },
          usageNotes: {
            type: 'string',
            description: 'One sentence on the season, water type, time of day, or weather where this specific pattern is generally most effective on this river - useful even when the fly is not the top pick for the current trip.',
          },
        },
        required: ['name', 'type', 'usageNotes'],
      },
    },
    likelyHatches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          insect: { type: 'string' },
          lifecycleStage: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['insect', 'reason'],
      },
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          flyName: { type: 'string' },
          rank: { type: 'number' },
          reason: { type: 'string' },
          sizeHint: { type: 'string', description: 'Typical hook size for this pattern, e.g. "#14-16". Always fill this in.' },
        },
        required: ['flyName', 'reason', 'sizeHint'],
      },
    },
    missingPatterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          reason: { type: 'string' },
          sizeHint: { type: 'string', description: 'Typical hook size for this pattern, e.g. "#14-16". Always fill this in.' },
        },
        required: ['name', 'reason', 'sizeHint'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['identifiedFlies', 'likelyHatches', 'recommendations', 'missingPatterns', 'summary'],
};

function extractOutputText(interaction) {
  const steps = (interaction && interaction.steps) || [];
  const texts = [];
  for (const step of steps) {
    if (step.type === 'model_output' && Array.isArray(step.content)) {
      for (const part of step.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          texts.push(part.text);
        }
      }
    }
  }
  return texts.join('');
}

async function analyzeWithGemini({ imageBase64, mimeType, river, locationInfo, date, timeOfDay, weather }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.');
  }

  const hasPhoto = Boolean(imageBase64);

  const contextLines = [
    `River/location as entered by angler: ${river}`,
    locationInfo.resolved
      ? `Resolved location: ${locationInfo.name} (lat ${locationInfo.latitude}, lon ${locationInfo.longitude})`
      : `Location could not be geocoded - use the raw text and general knowledge of that river if you recognize it.`,
    `Date of trip: ${date}`,
    `Time of day: ${timeOfDay}`,
    weather.available
      ? `Weather (${weather.note}): high ${weather.tempMaxC}C / low ${weather.tempMinC}C, precipitation ${weather.precipitationMm}mm, max wind ${weather.windSpeedMaxKmh}km/h, avg cloud cover ${weather.cloudCoverPercent}%`
      : `Weather: unavailable (${weather.note}). Reason using typical seasonal conditions for this location and date instead.`,
  ].join('\n');

  const prompt = hasPhoto
    ? `You are an expert fly fishing guide and aquatic entomologist. A photo of an angler's fly box is attached.

Trip context:
${contextLines}

Tasks:
1. Identify each distinct fly visible in the photo, giving your best guess at the common pattern name (e.g. "Elk Hair Caddis", "Pheasant Tail Nymph", "Woolly Bugger") even if you're not fully certain.
2. Reason about the aquatic and terrestrial insect hatches that are typically active on this river/region for this date, season, time of day, and weather.
3. Recommend which of the identified flies the angler should use, ranked 1 (best) upward, with reasons grounded in the likely hatches and conditions, and a typical hook size for each. Reference flyName values that match entries from step 1.
4. Note any well-known patterns for this hatch that the angler appears to be missing from their box, with a typical hook size for each.
5. For every fly identified in step 1, including ones not recommended for this trip, give a short one-sentence usage note on the season, water type, time of day, or weather where that specific pattern is typically most effective on this type of river.
6. Write a short 2-4 sentence natural-language summary for the angler.`
    : `You are an expert fly fishing guide and aquatic entomologist. The angler has NOT provided a photo - they're starting from scratch (or want fresh ideas) and want to know what flies to buy or tie for this trip.

Trip context:
${contextLines}

Tasks:
1. Return an empty array for identifiedFlies (there's no photo to inspect).
2. Reason about the aquatic and terrestrial insect hatches that are typically active on this river/region for this date, season, time of day, and weather.
3. Recommend the ideal starter set of fly patterns for this trip, ranked 1 (best) upward, each with a reason grounded in the likely hatches/conditions and a typical hook size.
4. Suggest a handful of additional well-rounded patterns worth adding beyond the top picks, each with a reason and typical hook size.
5. Leave usageNotes empty for identifiedFlies since there are none.
6. Write a short 2-4 sentence natural-language summary for the angler.`;

  const input = [{ type: 'text', text: prompt }];
  if (hasPhoto) {
    input.push({ type: 'image', data: imageBase64, mime_type: mimeType });
  }

  const body = {
    model: GEMINI_MODEL,
    input,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: RESULT_JSON_SCHEMA,
    },
  };

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = extractOutputText(data);
  if (!content) {
    throw new Error('Gemini response did not contain any content.');
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON response: ${err.message}`);
  }
}

// Best-effort real reference photo for a named fly pattern, so the angler can
// visually compare it against what's in their box. Wikimedia Commons is free,
// keyless, and has decent coverage of classic/well-known fly patterns. When it
// doesn't have a match, we fall back to a search-engine link instead of an
// inline image.
async function fetchReferenceImage(flyName) {
  const searchUrl = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(`${flyName} fly fishing pattern`)}`;
  if (!flyName || !flyName.trim()) {
    return { imageUrl: null, sourceUrl: null, searchUrl };
  }

  try {
    const query = `${flyName} fly fishing`;
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=5&gsrnamespace=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=300&origin=*`;
    const res = await fetch(url);
    if (!res.ok) return { imageUrl: null, sourceUrl: null, searchUrl };

    const data = await res.json();
    const pages = data && data.query && data.query.pages;
    if (!pages) return { imageUrl: null, sourceUrl: null, searchUrl };

    // Commons full-text search often surfaces scanned PDF books (old fishing
    // manuals, magazines, etc.) that happen to mention the fly name - skip
    // anything that isn't an actual photo/image file.
    const candidates = Object.values(pages);
    const match = candidates.find((page) => {
      const info = page.imageinfo && page.imageinfo[0];
      return info && typeof info.mime === 'string' && info.mime.startsWith('image/');
    });
    const info = match && match.imageinfo && match.imageinfo[0];
    if (!info) return { imageUrl: null, sourceUrl: null, searchUrl };

    return {
      imageUrl: info.thumburl || info.url || null,
      sourceUrl: info.descriptionurl || info.url || null,
      searchUrl,
    };
  } catch (err) {
    console.error(`Reference image lookup failed for "${flyName}":`, err.message);
    return { imageUrl: null, sourceUrl: null, searchUrl };
  }
}

async function attachReferenceImages(identifiedFlies) {
  if (!Array.isArray(identifiedFlies)) return identifiedFlies;
  const withImages = await Promise.all(
    identifiedFlies.map(async (fly) => {
      const ref = await fetchReferenceImage(fly.name);
      return { ...fly, referenceImageUrl: ref.imageUrl, referenceImageSourceUrl: ref.sourceUrl, referenceImageSearchUrl: ref.searchUrl };
    })
  );
  return withImages;
}

// Fuzzy name matching so "Elk Hair Caddis" (from recommendations) lines up
// with "Elk hair caddis, size 14" (as identified from the photo) etc.
function normalizeFlyName(name) {
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function namesMatch(a, b) {
  const na = normalizeFlyName(a);
  const nb = normalizeFlyName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function findMatchingFly(name, flies) {
  if (!Array.isArray(flies)) return null;
  return flies.find((f) => namesMatch(f.name, name)) || null;
}

async function enrichRecommendations(recommendations, identifiedFlies) {
  if (!Array.isArray(recommendations)) return recommendations;
  return Promise.all(
    recommendations.map(async (rec) => {
      const matched = findMatchingFly(rec.flyName, identifiedFlies);
      if (matched) {
        return {
          ...rec,
          inBox: true,
          sizeHint: matched.sizeHint || null,
          colorNotes: matched.colorNotes || null,
          referenceImageUrl: matched.referenceImageUrl || null,
          referenceImageSourceUrl: matched.referenceImageSourceUrl || null,
          referenceImageSearchUrl: matched.referenceImageSearchUrl || null,
        };
      }
      const ref = await fetchReferenceImage(rec.flyName);
      return {
        ...rec,
        inBox: false,
        sizeHint: rec.sizeHint || null,
        colorNotes: null,
        referenceImageUrl: ref.imageUrl,
        referenceImageSourceUrl: ref.sourceUrl,
        referenceImageSearchUrl: ref.searchUrl,
      };
    })
  );
}

async function enrichMissingPatterns(missingPatterns) {
  if (!Array.isArray(missingPatterns)) return missingPatterns;
  return Promise.all(
    missingPatterns.map(async (pattern) => {
      const ref = await fetchReferenceImage(pattern.name);
      return {
        ...pattern,
        referenceImageUrl: ref.imageUrl,
        referenceImageSourceUrl: ref.sourceUrl,
        referenceImageSearchUrl: ref.searchUrl,
      };
    })
  );
}

async function enrichHatches(likelyHatches) {
  if (!Array.isArray(likelyHatches)) return likelyHatches;
  return Promise.all(
    likelyHatches.map(async (hatch) => {
      const ref = await fetchReferenceImage(hatch.insect);
      return {
        ...hatch,
        referenceImageUrl: ref.imageUrl,
        referenceImageSourceUrl: ref.sourceUrl,
        referenceImageSearchUrl: ref.searchUrl,
      };
    })
  );
}

// Flies the angler owns that weren't specifically called out as a top
// recommendation or a suggested addition - shown at the bottom as "other".
function computeOtherFlies(identifiedFlies, recommendations, missingPatterns) {
  if (!Array.isArray(identifiedFlies)) return [];
  const recommendedNames = (recommendations || []).map((r) => r.flyName);
  const missingNames = (missingPatterns || []).map((m) => m.name);
  return identifiedFlies.filter((fly) => {
    const inRecommended = recommendedNames.some((n) => namesMatch(fly.name, n));
    const inMissing = missingNames.some((n) => namesMatch(fly.name, n));
    return !inRecommended && !inMissing;
  });
}

// ---- Routes -----------------------------------------------------------------

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    const { river, date, timeOfDay } = req.body;
    if (!river || !date || !timeOfDay) {
      return res.status(400).json({ error: 'river, date, and timeOfDay are all required.' });
    }

    const hasPhoto = Boolean(req.file);

    const locationInfo = await geocodeLocation(river);
    const weather = await fetchWeather(locationInfo, date);

    const analysis = await analyzeWithGemini({
      imageBase64: hasPhoto ? req.file.buffer.toString('base64') : null,
      mimeType: hasPhoto ? req.file.mimetype : null,
      river,
      locationInfo,
      date,
      timeOfDay,
      weather,
    });

    analysis.identifiedFlies = await attachReferenceImages(analysis.identifiedFlies);
    analysis.recommendations = await enrichRecommendations(analysis.recommendations, analysis.identifiedFlies);
    analysis.missingPatterns = await enrichMissingPatterns(analysis.missingPatterns);
    analysis.likelyHatches = await enrichHatches(analysis.likelyHatches);
    analysis.otherFlies = computeOtherFlies(analysis.identifiedFlies, analysis.recommendations, analysis.missingPatterns);

    res.json({
      hasPhoto,
      locationResolved: locationInfo.resolved,
      resolvedLocationName: locationInfo.resolved ? locationInfo.name : null,
      weather,
      ...analysis,
    });
  } catch (err) {
    console.error('Analyze failed:', err);
    res.status(500).json({ error: err.message || 'Something went wrong analyzing your flies.' });
  }
});

app.listen(PORT, () => {
  console.log(`Fly Box Advisor running at http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set. Requests to /api/analyze will fail until you add one to .env.');
  }
});

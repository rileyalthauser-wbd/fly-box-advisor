require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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

const RESULT_SHAPE_INSTRUCTIONS = `
Respond with ONLY a JSON object (no markdown, no code fences) with exactly this shape:
{
  "identifiedFlies": [
    { "name": string, "type": "dry" | "nymph" | "emerger" | "streamer" | "wet" | "terrestrial" | "other", "sizeHint": string, "colorNotes": string, "confidence": number between 0 and 1 }
  ],
  "likelyHatches": [
    { "insect": string, "lifecycleStage": string, "reason": string }
  ],
  "recommendations": [
    { "flyName": string, "rank": number, "reason": string }
  ],
  "missingPatterns": [
    { "name": string, "reason": string }
  ],
  "summary": string
}
- "identifiedFlies" should list every distinguishable fly you can see in the photo, giving your best guess at the common pattern name (e.g. "Elk Hair Caddis", "Pheasant Tail Nymph", "Woolly Bugger") even if you're not fully certain.
- "recommendations" should reference flyName values that match (or closely match) entries in identifiedFlies, ranked 1 (best) upward, with the reason tied to the likely hatches/conditions.
- "missingPatterns" should suggest patterns that would help given the likely hatches but were NOT spotted in the photo.
- "summary" is a short 2-4 sentence natural-language takeaway for the angler.
`;

async function analyzeWithGemini({ imageBase64, mimeType, river, locationInfo, date, timeOfDay, weather }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.');
  }

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

  const prompt = `You are an expert fly fishing guide and aquatic entomologist. A photo of an angler's fly box is attached.

Trip context:
${contextLines}

Tasks:
1. Identify each distinct fly visible in the photo.
2. Reason about the aquatic and terrestrial insect hatches that are typically active on this river/region for this date, season, time of day, and weather.
3. Recommend which of the identified flies the angler should use, ranked, with reasons grounded in the likely hatches and conditions.
4. Note any well-known patterns for this hatch that the angler appears to be missing from their box.

${RESULT_SHAPE_INSTRUCTIONS}`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  if (!content) {
    throw new Error('Gemini response did not contain any content.');
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON response: ${err.message}`);
  }
}

// ---- Routes -----------------------------------------------------------------

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    const { river, date, timeOfDay } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'An image of your fly box is required.' });
    }
    if (!river || !date || !timeOfDay) {
      return res.status(400).json({ error: 'river, date, and timeOfDay are all required.' });
    }

    const locationInfo = await geocodeLocation(river);
    const weather = await fetchWeather(locationInfo, date);

    const imageBase64 = req.file.buffer.toString('base64');
    const analysis = await analyzeWithGemini({
      imageBase64,
      mimeType: req.file.mimetype,
      river,
      locationInfo,
      date,
      timeOfDay,
      weather,
    });

    res.json({
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

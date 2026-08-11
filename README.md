# Fly Box Advisor (prototype)

A local prototype web app: photograph your fly box, tell it the river, date, and time of day you're
fishing, and it will identify the flies it sees and recommend which ones to use based on likely
insect hatches and the weather for that trip.

This is a prototype - minimal error handling, no accounts, no database, no deployment setup. Each
visit is a fresh session: nothing is saved between requests.

## How it works

1. You upload/take a photo of your fly box and fill in the river/location, date, and time of day.
2. The server geocodes the river/location text (via the free Open-Meteo geocoding API) and fetches
   weather for that date/location (forecast for near-term dates, historical archive for past dates,
   or a "same date last year" estimate for dates too far out to forecast).
3. The photo plus all of that context is sent to Google's Gemini API in a single request, which
   identifies the flies in the photo and reasons about likely hatches to produce ranked
   recommendations.
4. Results are rendered in the browser: identified flies, likely hatches, ranked recommendations,
   and patterns you might be missing.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and add your Gemini API key:

   ```bash
   cp .env.example .env
   ```

   Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey), then edit `.env`
   and set `GEMINI_API_KEY=...`. You can also change `GEMINI_MODEL` if you'd like to use a
   different vision-capable Gemini model (default is `gemini-2.5-flash`).

3. Start the server:

   ```bash
   npm start
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser. On a phone, using it over
   your local network lets the camera-capture input open your camera directly.

## Notes

- If the river/location text doesn't geocode cleanly (e.g. an obscure creek name), the app will
  still work - it just won't have real weather data, and will note that in the results while the
  model falls back to general seasonal reasoning.
- Weather for dates more than ~16 days in the future is approximated using the same calendar date
  from the previous year, since forecasts aren't available that far out.

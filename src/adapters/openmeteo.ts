import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { http } from "../core/http.js";

// WMO weather interpretation codes → human-readable description
const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Icy fog", 51: "Light drizzle", 53: "Moderate drizzle",
  55: "Dense drizzle", 61: "Light rain", 63: "Moderate rain", 65: "Heavy rain",
  71: "Light snow", 73: "Moderate snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Moderate rain showers", 82: "Heavy rain showers",
  85: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm with hail",
};

// Country codes to bias geocoding for ambiguous city names
// "Kochi" could be Japan (jp) or India (in) — we bias toward India by default
// unless the query contains explicit country signals
const COUNTRY_SIGNALS: [RegExp, string][] = [
  [/\b(japan|tokyo|osaka|kyoto|sapporo)\b/i, "jp"],
  [/\b(uk|england|london|scotland|wales|britain)\b/i, "gb"],
  [/\b(australia|sydney|melbourne|brisbane|perth)\b/i, "au"],
  [/\b(usa|us|america|new york|los angeles|chicago)\b/i, "us"],
  [/\b(kerala|india|mumbai|delhi|bangalore|chennai|hyderabad|kolkata)\b/i, "in"],
  [/\b(germany|berlin|munich|frankfurt)\b/i, "de"],
  [/\b(france|paris|lyon|marseille)\b/i, "fr"],
];

function inferCountryCodes(query: string): string {
  for (const [pattern, code] of COUNTRY_SIGNALS) {
    if (pattern.test(query)) return code;
  }
  return "in,us,gb,au,ca"; // multi-country default — geocoder picks most prominent
}

/**
 * Strips weather-query boilerplate words to extract the city name.
 * "current weather in Kochi" → "Kochi"
 * "Kochi Kerala weather today" → "Kochi Kerala"
 */
function extractCity(query: string): string {
  return query
    .replace(/\b(current|today|now|live|forecast|weather|temperature|temp|humidity|what is the|what's the|in|for|at|check)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export class OpenMeteoEngine implements Engine {
  readonly name = "openmeteo" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const city = extractCity(query);
    if (!city || city.length < 2) return [];

    const halfBudget = Math.floor(timeoutMs / 2);

    // Step 1: geocode city → lat/lon via Nominatim (OSM, no key required)
    const geoUrl = new URL("https://nominatim.openstreetmap.org/search");
    geoUrl.searchParams.set("q", city);
    geoUrl.searchParams.set("format", "json");
    geoUrl.searchParams.set("limit", "1");
    geoUrl.searchParams.set("countrycodes", inferCountryCodes(query));

    const geo = await http.get(geoUrl.toString(), {
      timeout: halfBudget,
      headers: { "User-Agent": "search100x/2.2.0 (open-source search package)" },
    });

    const loc = geo.data?.[0];
    if (!loc) return [];

    // Step 2: fetch current weather from Open-Meteo (free, no key, no rate limit)
    const wx = await http.get("https://api.open-meteo.com/v1/forecast", {
      timeout: halfBudget,
      params: {
        latitude:  loc.lat,
        longitude: loc.lon,
        current:   "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature,precipitation",
        timezone:  "auto",
        forecast_days: "1",
      },
    });

    const c = wx.data?.current;
    if (!c) return [];

    const desc    = WMO[c.weather_code as number] ?? "Unknown conditions";
    const cityName = loc.display_name.split(",")[0].trim();
    const country  = loc.display_name.split(",").slice(-1)[0].trim();

    // Prepend city + "weather" so BM25 matches query tokens ("kochi weather current")
    const snippet = [
      `${cityName} weather: ${desc}.`,
      `Temperature: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C).`,
      `Humidity: ${c.relative_humidity_2m}%.`,
      `Wind: ${c.wind_speed_10m} km/h.`,
      c.precipitation > 0 ? `Precipitation: ${c.precipitation} mm.` : "",
    ].filter(Boolean).join(" ");

    return [{
      title:       `Current Weather in ${cityName}, ${country}`,
      url:         `https://open-meteo.com/en/docs#latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code`,
      snippet,
      publishedAt: new Date(),
    }];
  }
}

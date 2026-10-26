# Texas Weather Cheddar

A generative weather broadcast for the state of Texas.

Live observations from the National Weather Service and the NEXRAD radar
mosaic drive two things at once: an **ambient score** written in real time from
the state of the atmosphere, and a **visual engine** that replaces the usual
vocabulary of a weather map with whatever you give it. Where a conventional
forecast draws a rain shield, this draws a cluster of your photographs. Where
it draws a cloud mass, this drifts a crowd of historical faces, or tacos, or
video clips, across the state along the real wind.

It renders to a canvas, scores itself through Web Audio, and streams the two
together to YouTube Live over RTMP.

![A broadcast frame: faces and cattle drifting across Texas as cloud masses, a
squall line rendered as a dense band of stars, station temperatures, a warning
banner and the readout](docs/preview.png)

*A frame from the synthetic rehearsal mode, with five placeholder images
standing in for cloud, rain, storm and heat — hence the SIMULATED badge, which
appears on any frame not built from live observations.*

---

## Quick start

```bash
npm install
npm run build:geo          # extracts Texas from the Census TIGER boundary file
npm start
```

Then open <http://localhost:8080/>. Press **c** (or the CONSOLE button) for the
operator console.

Before going anywhere near live data, put a real contact address in
`NWS_USER_AGENT` — NOAA asks API clients to identify themselves, and an
anonymous client can be rate-limited or blocked:

```bash
cp .env.example .env     # then edit NWS_USER_AGENT
```

Run `npm run check` at any point; it exercises the unit conversions, the radar
palette, the field maths, the upload and remote-source guards, and the
weather-to-music mapping without touching the network.

---

## Where the data comes from

| Feed | Source | Refresh | Used for |
|---|---|---|---|
| Surface observations | [NWS API](https://www.weather.gov/documentation/services-web-api) `api.weather.gov` | 2.5 min | temperature, dewpoint, humidity, wind, pressure, sky cover, present weather |
| Watches & warnings | NWS `/alerts/active?area=TX` | 2.5 min | the alert banner, the storm channel, musical tension |
| Radar mosaic | [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/ogc/) NEXRAD **N0Q** composite | 2 min | where precipitation actually is, at a few-kilometre resolution |

Both are public and keyless. Station discovery comes from NWS itself
(`/stations?state=TX`), thinned across a grid so coverage stays even, and
cached to disk; a committed roster of ~40 airports is the cold-start fallback.

The radar PNG arrives palettised to the standard NWS reflectivity ramp, so
decoding is a nearest-colour lookup back to dBZ, and from there to mm/h via the
Marshall–Palmer relation `Z = 200R^1.6`. The 40-odd point observations are
interpolated onto a 112×96 grid with inverse-distance weighting. That grid,
plus the station list and alerts, is the **WeatherFrame** — the single
structure the visuals and the score both read, pushed to the browser over
server-sent events.

### When a feed is unavailable

Three honest behaviours, never a silent invention:

- **`WEATHER_SOURCE=nws`** — live only. If a refresh fails, the last good frame
  is held and marked `STALE` on screen. Nothing is fabricated.
- **`WEATHER_SOURCE=auto`** (default) — live, falling back to the synthetic
  model if NOAA is unreachable. Fallback frames are stamped
  `source: "synthetic"` and the broadcast shows an unmissable
  **SIMULATED — NOT NWS OBSERVATIONS** badge.
- **`WEATHER_SOURCE=synthetic`** — rehearsal. A physically-plausible cold front
  crosses the state every 150 minutes with a convective line along it, so you
  can build and tune a show without waiting for real weather. Always badged.

If the radar is unreachable but observations are fine, precipitation falls back
to station present-weather reports and the frame says so in `notes`.

---

## The visual engine

Upload stills or clips, then tag each one with the **channels** it should stand
in for. A channel is a scalar field read from the live data:

| Channel | Driven by | Appears when |
|---|---|---|
| `cloud` | interpolated sky cover | anywhere cloudy |
| `rain` | radar reflectivity | anywhere with echo |
| `storm` | reflectivity² and alert severity | convective cores, warning polygons |
| `heat` | temperature | above ~28 °C, saturating near 42 °C |
| `cold` | temperature | below ~10 °C, saturating near −6 °C |
| `wind` | wind speed | above ~6 kt |
| `calm` | low wind and clear sky | still, open air |

Population is proportional to how much of Texas a field currently covers, so a
clear day is sparse and a squall line is dense. Sprites are placed around
cluster anchors found in the strongest parts of each field — that is what makes
media arrive in *masses* rather than an even dusting — and they are advected by
the real wind, feathering out when they cross the state line.

Per item you get scale, opacity, weight (how often it is picked), rotation
(`none` / `drift` / `spin` / `align-wind`), mask (`soft` by default, or
`circle` / `blob` / `none`), blend mode, and playback rate for clips.

**Live sources.** Beyond uploads, the engine takes a remote still re-fetched on
an interval (a traffic camera, a satellite image, a collaborator's render), a
remote video URL, or the operator's **webcam or screen** — each usable as a
weather channel, or as the texture of the land itself. Remote URLs are fetched
through a guarded server proxy: `http(s)` only, public addresses only, image
and video content types only, size-capped.

### Map styling

Every colour is yours: background, land, land shadow, outline, county lines,
glow, label ink, and the two endpoints of the temperature ramp that shades the
land. Texture is procedural — `grain`, `paper`, `scanlines`, `halftone`,
`weave`, `topo` — or any uploaded image, with scale, rotation and strength.
Plus vignette, film grain, bloom, outline glow and county-line weight.

Geometry is real: all 254 Texas counties from the Census TIGER 1:10,000,000
boundary file, drawn in an Albers equal-area conic projection with standard
parallels at 27.5°N and 35°N, so the Panhandle and the Valley are both honest.

---

## The score

Six voices, all parameterised by the live weather, through a generated-impulse
reverb into a soft limiter:

| Voice | Listens to |
|---|---|
| drone | root pitch from temperature, detune from barometric pressure, filter from cloud cover |
| pad | voicing thickness from humidity, dissonance from the frontal temperature gradient |
| wind | band-passed noise; centre frequency and level from wind speed, stereo position from direction, swells on gusts |
| rain | granular noise; density from radar coverage, brightness from rain rate |
| thunder | low sweep and noise body; probability from storm-cell count and alert severity |
| bells | generative FM voice picking notes from the active mode |

Mode follows temperature from phrygian through aeolian, dorian and mixolydian
to lydian, with heavy weather overriding brightness — a squall line is not
lydian. The root walks the circle of fifths so a slow warming moves to a
neighbouring key rather than lurching. Wind sets the pulse: dead calm is an
event every ~9 s, a 40 kt gale every ~1.3 s. All of it is overridable from the
console if you would rather fix the key and mix it by hand.

---

## Streaming to YouTube

1. In YouTube Studio, **Create → Go live → Stream**, and copy the stream key.
2. Console → **Broadcast**. Paste the key, pick a quality, press **Go live**.
3. YouTube takes 10–20 seconds to show the preview. Stop from the same panel.

The key is sent once, never written to disk, and masked everywhere it could
appear in a log.

Two encoders:

- **headless** (default) — the server drives its own Chromium through
  Playwright, so the broadcast keeps running with no window open anywhere.
  Needs `npm install playwright && npx playwright install chromium`.
- **external** — your own browser is the encoder. Useful when the server has no
  GPU, or when you want to watch exactly what goes out.

Either way the chain is the same: canvas + Web Audio → `MediaStream` →
`MediaRecorder` (WebM/VP9+Opus) → WebSocket → ffmpeg → H.264/AAC in FLV →
RTMP. A fixed two-second GOP and constant frame rate is what YouTube's ingest
expects. If the encoder cannot produce an audio track, silence is substituted
rather than publishing a video-only stream, which YouTube rejects.

Set the target to **local file** instead of RTMP to rehearse the whole pipeline
without publishing anything.

### Performance

Sprite fill rate is the dominant cost, and rotated sprites cost about four
times an axis-aligned blit. The engine therefore runs an **adaptive quality
governor**: it measures the frame rate and thins the sprite population until
the target holds, because a broadcast that quietly drops to 18 fps looks worse
than one carrying fewer tacos. The HUD shows the factor in use.

Measured on this project's CI container — headless Chromium with **no GPU**, so
every pixel is rasterised on the CPU, which is the pessimistic case:

| Preset | Result |
|---|---|
| 480p30 | 36 fps at the full sprite budget |
| 720p30 | ~30 fps at roughly half the budget |
| 1080p30 | ~30 fps, but only with the population thinned hard |

`720p30` is the default for that reason. With GPU-accelerated canvas — any
ordinary desktop browser as an external encoder, or a server with a GPU —
1080p has far more headroom. Film grain and bloom each cost a full-canvas
compositing pass and are off by default.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/weather/frame` | the latest WeatherFrame |
| GET | `/api/weather/stream` | SSE feed of frames |
| GET | `/api/weather/status` | source, station roster, per-feed health |
| POST | `/api/weather/source` | `{ mode: "auto" \| "nws" \| "synthetic" }` |
| POST | `/api/weather/refresh` | force a poll now |
| GET | `/api/media` | the media library |
| POST | `/api/media/upload` | multipart upload (images, clips) |
| POST | `/api/media/remote` | register a remote source |
| PATCH/DELETE | `/api/media/:id` | retag, restyle, remove |
| GET | `/api/media/proxy?url=` | guarded fetch for remote media |
| GET/PATCH | `/api/show` | the whole show configuration |
| POST | `/api/show/reset` | back to defaults |
| GET | `/api/stream/status` | broadcast state and ffmpeg log tail |
| POST | `/api/stream/start` · `/api/stream/stop` | drive the broadcast |
| GET | `/api/health` | liveness, feed health, media count |

The show lives in `data/show.json`, so a broadcast survives a restart and the
headless encoder renders exactly what you tuned.

---

## Layout

```
server/
  weather/     NWS client, NEXRAD decoding, IDW field assembly, synthetic model
  stream/      ffmpeg + headless-Chromium broadcast pipeline
  lib/         media library, show config, HTTP helpers and the SSRF guard
public/js/
  visual/      projection, map, procedural textures, media pool, particles, overlay
  audio/       weather-to-music mapping and the Web Audio engine
  net/         SSE feed and frame decoding, encoder client
  ui/          the operator console
scripts/       geometry build, self-check
```

## Credits and terms

Weather data from the **US National Weather Service / NOAA**, a public-domain
work of the US federal government. Radar mosaic courtesy of the **Iowa
Environmental Mesonet**, Iowa State University. Boundaries from the **US Census
Bureau** TIGER/Line cartographic files via `us-atlas`. Please keep a real
contact address in `NWS_USER_AGENT` and leave the polling intervals alone
unless you have a reason — these are free services.

Uploaded media is yours; nothing is sent anywhere except the video you choose
to broadcast.

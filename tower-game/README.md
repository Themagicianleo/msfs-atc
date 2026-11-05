# Tower Controller

A browser game: you are the tower controller at a real airport. Arrivals call you
on final, departures call for pushback, taxi and take-off, and you give the
instructions by **voice**, typing or buttons. Pilots read back with the device's
own voices.

It is a static website: no server, no account, no install, nothing to do with any
flight simulator. It runs on GitHub Pages, on an iPad (Safari, or added to the
Home Screen) and on a PC (Chrome or Edge). Original code and content; not
affiliated with any commercial tower-simulator game. A game, not for real-world use.

## Play

Open the site, type an airport (ICAO code, name or city, e.g. `EGLL`, `Haneda`,
`Shanghai`, or `DEMO` for the fictional demo field), choose the traffic, and press
**Start shift**. Use headphones, so the microphone doesn't pick up the pilots.

- **Select** an aircraft by tapping it on the map or its strip. A yellow ring and a
  highlighted strip mean it is calling you; the blue button is the usual answer.
- **Talk:** tap **Start talking**, say the callsign and the instruction, then tap **Stop and send**
  (it also sends by itself when you pause). On a PC you can hold the **space bar** instead. With an
  aircraft selected you can skip the callsign.
- **Instructions understood:**
  - *Speedbird 123, runway 27, cleared to land* · *continue approach* · *go around*
  - *pushback approved*
  - *taxi to holding point runway 27 [via alpha] [cross runway 15]* · *taxi to stand 12 [via bravo]*
  - *hold position* · *continue taxi* · *cross runway 15* · *hold short runway 27*
  - *runway 27, line up and wait* · *cleared for take-off* · *contact departure, good day*

  Numbers work as "two seven" or "twenty seven", letters as "alpha" or "a".
- **Pilots** do what you say but use their eyes:
  - Arrivals without a landing clearance go around at 0.9 NM, and at 0.3 NM if the runway is still occupied.
  - Taxiing aircraft stop for traffic on their route and hold short of runways until cleared to cross.
  - A departure won't roll while someone is ahead on the runway.
  - Unanswered calls are repeated.
- **Score:**
  - Points: +50 per arrival parked, +50 per departure handed to departure (+15 if you
    forgot the frequency change).
  - Penalties: −100 go-around without landing clearance, −150 go-around with the runway
    occupied, −250 runway conflict, −200 ground conflict, −10 per repeated call, −30 gridlock.
- **Controls:** pause/1x/2x/4x speed; traffic None, Calm, Normal or Busy. Change the
  landing and departure runways with **Arr/Dep**, and the wind under **Settings and help**.
- **Views:** the switch over the map has three settings:
  - **Map:** the 2D map (and **Chart**).
  - **Tower:** the view from the tower cab. Drag to look around; pinch or scroll to zoom like binoculars.
  - **3D:** a free camera. Drag to orbit, pinch or scroll to zoom. **Follow** keeps the selected aircraft in view.

  **Fit** resets the camera. You can select aircraft by tapping them in every view.

### 3D views

The 3D views use [three.js](https://threejs.org/) (MIT licence, included as `js/vendor/`). It loads only
when you first open a 3D view, so the 2D map stays as fast as before.

- **Aircraft** are simple low-poly models built from each type's real length and wingspan. Four-engine types
  (A380, 747) get four engines. The tail colour is a plain colour per airline, not its livery.
- **Ground** is built from the same layout as the map: runways with centrelines, threshold and aiming-point
  marks, numbers and edge lights; taxiways with yellow centrelines; aprons; red holding points.
- **Buildings** are the terminal and hangar outlines, raised to a fixed height (22 m terminals, 16 m others).
  Real heights are not in the data.
- **Tower:** at Daxing it stands where the CAAC aircraft parking chart (ZBAD 2P-1, 2025-03-15) shows the west
  tower, TWR(W), in the courtyard south-west of the terminal; the position was read off the chart against
  nearby stands, so it is approximate. OpenStreetMap has no usable tower position for Changi and San Francisco,
  so there the game puts it in the open space nearest the middle of the terminals. The cab is at about 72 m.
  Set `meta.tower_pos` in `data/traffic/<ICAO>.json` to move it.
- **Appearance:** light and dark follow the game's appearance; dark looks like dusk, with runway lights.

### The detailed airports: WSSS, ZBAD, KSFO

**Singapore Changi (WSSS), Beijing Daxing (ZBAD) and San Francisco (KSFO)** use the real
airport layout from [OpenStreetMap](https://www.openstreetmap.org/copyright)
(© OpenStreetMap contributors, ODbL). That includes:
- runways and real named taxiways and taxilanes;
- holding positions;
- stands with their real numbers (stand sizes are estimated from their spacing,
  so an A380 only gets a stand big enough for it);
- aprons and terminal buildings.

**Chart button:** switches the map to an airport-diagram style with every taxiway name
in yellow boxes, holding points and stand numbers (zoom in for taxilanes and stands).
Taxi instructions use the real names: *taxi to holding point runway 02C via whiskey
alpha, bravo one*. Spoken letters are matched against the airport's actual taxiway
names, and pilots refuse taxiways that don't exist.

**Traffic** comes from the airlines that serve each airport. Each one uses its real
radio callsign (*Singapore*, *Scooter*, *China Southern*, *Lianhang*, *United*,
*Skywest*…), a typical fleet there, and real destinations. Aircraft are drawn to
scale and use their own approach and rotation speeds and ICAO wake category.

**Wake turbulence:**
- Arrivals are spaced on final by wake category (e.g. 5 NM for a medium behind a
  heavy, 7 NM behind an A380).
- A departure that starts its take-off roll too soon behind a heavier one from the same
  runway costs points (2 min behind a heavy, 3 min behind an A380 for medium aircraft).

**Runway plans:**
- San Francisco uses its West Plan (land 28L and 28R, depart 1L and 1R) or Southeast
  Plan (land 19L/19R, depart 10L/10R), depending on the wind.
- Changi lands on 02L/20R and departs 02C/20C.
- Daxing lands on the runway most into the wind and departs from a parallel one.
- Change any of them with the Arr/Dep menus (e.g. `28L+28R`).

The traffic mix is representative, not a real schedule, and the runway plans are
simplified. OSM is volunteer-mapped and can be incomplete or out of date. Never use
any of this for real-world navigation. Files: `data/traffic/<ICAO>.json` (airlines,
fleets, runway plans), `data/aircraft.json` (types), `data/osm/` (OSM extracts),
`data/hq/` (built layouts).

To refresh the layouts, run the **Tower game - fetch OpenStreetMap airport data**
workflow, or `python tools/fetch_osm.py` where the OSM servers are reachable, then
`node tools/build_hq.mjs`. The build prints a quality report: exits per runway, entries,
and whether every stand can reach every runway.

### Beijing Daxing: Chinese radio, metric units

At **ZBAD**, Chinese airlines work the tower in **Chinese**, as domestic flights do in China.

- **Callsigns** are Chinese: 南方 (China Southern), 东方 (China Eastern), 白鹭 (Xiamen Air), 联航 (China
  United), 首都 (Capital), 山东 (Shandong), 四川 (Sichuan), 吉祥 (Juneyao).
- **Numbers** are spoken the aviation way: 幺 1, 两 2, 拐 7, 洞 0.
- **Typical calls:** 「大兴塔台，南方3101，盲降跑道35右，18公里」, 「跑道35右，可以落地，南方3101」,
  「经A、B2滑到跑道35左外等待点」, 「进跑道等待」, 「可以起飞」, 「联系离场，再见」.
- **Foreign airlines** (Aeroflot) use English.
- **Units:** wind in m/s, distances on final in km, speeds in km/h and heights in metres.

You can answer in Chinese by voice or typing, e.g. 「南方三幺洞幺，跑道三五右，可以落地」. A **中文 / EN** switch
next to the talk button sets the microphone language. It is Chinese by default at ZBAD, and English for Aeroflot.
Spoken Chinese needs a Chinese system voice (on iPad: Settings → Accessibility → Spoken Content → Voices →
Chinese). The Chinese wording is in `data/phraseology-zh.json`.

**Checked against the CAAC chart:** every Daxing stand number in the game appears on the CAAC aircraft parking
chart (2025-03-15), except OpenStreetMap's "E6", which the chart doesn't have (E6 is a taxiway), so it is no longer
used (`meta.not_stands`). OpenStreetMap still lacks many of the chart's stands: the south remote stands 301–373,
most of 421–483, the cargo stands 501–526, 701–706, the de-icing stands and the business apron. Traffic only uses
the 101 numbered stands it has.

The Chinese callsigns and the simplified CAAC-style wording are from general knowledge; check them against
the CAAC radiotelephony rules if accuracy matters to you.

### Look

The game uses the design of the MSFS Buddy EFB (its `glass.css`, copied as `efb-glass.css`):
- frosted glass cards over a soft ambient light;
- capsule controls and segmented buttons;
- Apple's system colours;
- light and dark appearance following the device, or set under **Settings → Appearance**.

The map has matching light and dark colours, and **Chart** switches to the airport-diagram style.

### The other airports

Runway positions, lengths and headings are real, from
[OurAirports](https://ourairports.com/data/) (public domain). The site includes
every open airport with a runway of at least 1200 m that has coordinates for both
runway ends.

OurAirports has no taxiways, stands or buildings, so these are **generated**, and
they won't match the real airport:
- two parallel taxiways along the main runway (A inner, B outer) and one along each
  other runway (C, D);
- numbered connectors (A1, A2…) with holding points (red bars);
- apron links J1–J3 and numbered stands;
- hold-short points wherever a taxiway crosses a runway.

At most the three longest runways are used.

**Wind:** the game first tries the live METAR from the NOAA Aviation Weather Center
(`aviationweather.gov`) directly from your browser. If the browser can't fetch it
(offline, or the service doesn't allow requests from other sites), it generates a
plausible wind for that airport and hour. The header shows "(gen.)" in that case.
You can always set the wind yourself.

## Put it on GitHub Pages

The workflow `.github/workflows/tower-game-pages.yml` tests the game, downloads
OurAirports, builds `data/airports/` and publishes the site.

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Make sure the workflow file is on the repository's **default branch**. Only that
   branch publishes; other branches only build and test.
3. Push a change under `tower-game/`, or run the workflow by hand (**Actions → Tower
   game on GitHub Pages → Run workflow**). It also re-runs weekly for data updates.
4. The site appears at `https://<user>.github.io/<repository>/`. The workflow run shows
   the exact address.

GitHub Pages is free for public repositories; private repositories need a paid
GitHub plan.

## Run it on your own computer

Any static web server works. The microphone needs `https://` or `localhost`.

```
cd tower-game
python tools/build_airports.py        # once: downloads OurAirports (about 20 MB) into data/airports/
python -m http.server 8000            # then open http://localhost:8000/
```

Without the data build you can still play `DEMO`.

## Voice recognition: what to expect

The game uses the browser's built-in speech recognition (`webkitSpeechRecognition`):
- **Chrome and Edge on a PC:** most reliable. Audio goes to the browser maker's
  speech service.
- **Safari on iPad:** works with Siri and Dictation enabled. It may not work when the
  game is added to the Home Screen; use a normal Safari tab then.
- **Firefox:** no speech recognition.

If recognition fails three times in a row, the talk button turns itself off; typing and
buttons always work. Accuracy for callsigns and numbers has not been measured.
Tapping the aircraft first means you only have to say the instruction.

## Edit

`data/phraseology.json` holds what pilots say, how they read back, the button texts
and the patterns that recognise your instructions (regular expressions).
`data/airlines.json` maps airline codes to radio callsigns.

## Develop

No build step: plain HTML, CSS and JavaScript modules.

```
npm test                               # layout generator, routing, traffic sim, commands, weather
python -m unittest discover -s tests   # airport data builder
node tools/e2e.mjs                     # headless Chromium plays the site (needs Playwright)
```

| Path | What |
|---|---|
| `js/layout.js` | airport layout generator and taxi routing |
| `js/world.js` | traffic simulation, conflicts, scoring (no DOM) |
| `js/commands.js` | understanding spoken or typed instructions |
| `js/render.js` | map drawing, pan/zoom/tap |
| `js/scene3d.js` | 3D tower and orbit views, low-poly aircraft (three.js in `js/vendor/`) |
| `js/app.js` | the page: loading, radio log, voice, buttons |
| `js/weather.js` | live METAR or generated wind |
| `js/lib/` | small helpers: text/speech formatting, number words, runway choice, speech output and input |

## Limitations

- **Aircraft:** arrivals fly a straight-in final with no radar vectors and no wake
  turbulence spacing; departures fly straight out; no VFR traffic or helicopters.
- **Gridlock:** two aircraft that block each other nose to nose for a minute pass
  through each other (with a penalty) instead of being rerouted.
- **Generated layouts:** unusual airports (very close parallel runways, many crossing
  runways) can give odd taxiway layouts. The layout generator has been tested on made-up
  airports only, because the real data download was not available when it was built.
- **Speed on an iPad:** not measured, for the 2D map or the 3D views. The 3D views have been tested only in
  headless Chromium with software rendering.

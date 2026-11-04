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
- **Talk:** hold **Hold to talk** (on a PC, hold the **space bar**) and say the
  callsign, then the instruction. With an aircraft selected you can skip the callsign.
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

### The airports

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
- **Speed on an iPad:** not measured.

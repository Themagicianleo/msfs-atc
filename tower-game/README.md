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

**Then choose the runways.** Busy airports land and depart on several runways at once, so the next step
lets you pick them:
- The game loads the airport's live METAR (or generates a wind if it can't) and **recommends a plan for that
  wind**, marked *Recommended* at the top of the list.
- Every runway end shows its headwind (or tailwind, in red) and crosswind. The best ones are first.
- Tap a plan to use it, or tap runway ends under **Landing** and **Departures** to build your own: any number of
  runways for each, and the same runway for both.
- Plans:
  - The airport's own plans: San Francisco's West and Southeast Plans, Changi's North and South. The one
    for the wind is recommended. If the wind suits none of them (a tailwind of 3 kt or more on landing),
    a plan straight into the wind is recommended instead, marked *not a published plan*, and the published
    plans stay on the list with their tailwind in red.
  - *Mixed* versions where the runways are parallel (Changi: both parallels land and depart). This is harder:
    arrivals and departures share runways, so you have to fit departures between arrivals.
  - Airports without published plans (Daxing and the generated ones): the runway into the wind with its
    parallels, split (some land, some depart) or mixed.
  - Anything else you like, runway by runway. Mixed plans and crossing runways are the hardest; at San
    Francisco, landing and departing on 28L/28R together needs careful crossing clearances.
- The **Runways** button over the map reopens the choice during the shift. **Next time, start straight away
  with the recommended runways** skips this step; turn it back on under **Settings → Ask which runways to use**.

- **Select** an aircraft by tapping it on the map or its strip. A yellow ring and a
  highlighted strip mean it is calling you; the blue button is the usual answer.
- **Where it's going:** aircraft on the ground show their destination on the strip, the map label and
  the 3D label. Departures go to the holding point of their runway, e.g. *→ RWY 02C*; arrivals go to their
  stand, e.g. *→ STAND 12*. The destination is ringed on the map when you select the aircraft.
- **Talk:** tap **Start talking**, say the callsign and the instruction, then tap **Stop and send**
  (it also sends by itself when you pause). On a PC you can hold the **space bar** instead. With an
  aircraft selected you can skip the callsign.
- **Like a real radio:** while you talk, every other aircraft is muted (whoever was speaking is cut off; it is
  still in the radio log, tap it to hear it again). Pilots who call meanwhile wait, and are heard when you let go,
  after the readback to your instruction.
- **Faster and more accurate listening:** the recogniser is told what to expect (the callsigns on frequency,
  the ICAO alphabet, this airport's taxiway names and the usual phrases; Chrome and Edge use this). Once what you
  said is a whole instruction and has stopped changing, it is sent without waiting for the browser's own
  end-of-speech delay: about half a second after you stop (a taxi route gets 0.9 s, since controllers pause between taxiways).
- **AI voice recognition (optional):** under **Settings → AI voice recognition** the game can use Whisper, an open-source
  speech model, running on your device instead of the browser's own recogniser (about 80 MB, downloaded once, then offline;
  the browser's recogniser is used until it is ready). It is told the callsigns on frequency, this airport's taxiways and the
  usual phrases, and what it hears is then matched **by sound** to those callsigns, to the ICAO alphabet inside a taxi route and
  to the command words. So callsigns that are not English words (*Shenzhen*, *Loong Air*, *Tianfu*) are found even when the
  model writes *Chen Jen* or *long air*. It is not retrained: it is guided by the prompt and the matching (`js/lib/asr-correct.js`).
  It recognises a whole transmission after you stop talking (a moment's delay), in English and Chinese.
- **Taxiway names are always said as code words,** by pilots in English (*alpha, bravo one, whiskey alpha*) and in Chinese
  (*阿尔法、布拉沃幺、威士忌阿尔法*), never as a bare letter. You can say them either way; both languages are understood.
- **Fast speech:** listening starts the moment you press (the key shows *Wait...* until the microphone is open;
  words said before that are lost). Merged words are split back (*alphabravo*, *bravo1*, *whiskeyalpha*), *double two* and
  *triple five* are read as digits, and clipped phrases work (*cleared land*, *hold pos*, *holdshort*, *go round*, *enter runway*).
- **Instructions understood:**
  - *Speedbird 123, runway 27, cleared to land* · *continue approach* · *go around*
  - *pushback approved [, expect runway 27R for departure]*
  - **Taxi routes, as in real life:** *taxi to holding point runway 27 via alpha, bravo one, cross runway 15, hold
    short of runway 09* · *taxi to stand 12 via whiskey alpha, then bravo* · *taxi via alpha, cross runway 15,
    then via mike* (the route can come in pieces; *taxiway* is optional). *Hold short of runway 15* inside a
    route stops the aircraft there until you clear it to cross.
  - *hold position* · *continue taxi* · *cross runway 15* · *hold short runway 27*
  - *runway 27, line up and wait* · *cleared for take-off* · *contact departure, good day*

  Numbers work as "two seven" or "twenty seven", letters as "alpha" or "a". The whole ICAO alphabet is understood
  with the usual recogniser spellings (alfa, juliett, x-ray, whisky, charley...), and words heard for a digit
  ("runway **to** seven left", "stand one **for**") are fixed when they stand next to a number.
- **Choose the taxi route on the map:** select an aircraft that is ready to taxi (or taxiing) and tap
  **Choose route on map**.
  - Tap points on the taxiways in the order it should use them. The route is drawn in yellow, and the bar
    shows the instruction, e.g. *via J3, B, A6 to holding point runway 36*.
  - Tap a holding point (departures) or a stand (arrivals) to change where it goes.
  - **Clear to cross runways** adds the crossing clearance to the instruction. Untick it to clear each
    crossing yourself later.
  - **Undo**, **Clear**, **Cancel** or **Send**. The aircraft taxis exactly that way and the pilot reads back
    the taxiways.
- **Pilots** do what you say but use their eyes:
  - Arrivals without a landing clearance go around at 0.9 NM, and at 0.3 NM if the runway is still occupied.
  - Taxiing aircraft stop for traffic on their route and hold short of runways until cleared to cross.
  - A departure won't roll while someone is ahead on the runway.
  - Unanswered calls are repeated.
- **No score.** Mistakes (a go-around you caused, a conflict, an aircraft that had to call again) appear in the radio log
  as plain warnings.
- **Colours:** arrivals are blue and departures magenta everywhere (map, 3D, tags, lists), drawn large with a rim and a
  soft halo; taxiways and runways stay grey, so aircraft are what the eye finds first.
- **Controls:** pause/1x/2x/4x speed; traffic None, Calm, Normal or Busy. Change the
  landing and departure runways with **Runways**, and the wind under **Settings and help**.
- **Pushback and the departure runway:** when you clear an aircraft for pushback, the tower tells it which
  runway to expect, and the pilot reads it back: *"Pushback approved, expect runway 27R for departure"*. By
  default that is the runway it was given (departures take the runways in use in turn; its strip shows
  *→ RWY 27R*). With several departure runways there is a pushback button for each, or say the runway
  yourself; the pilot then expects that one. Aircraft still at their stand follow a runway change.
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
  nearby stands, so it is approximate. At Changi it is at the coordinates the AIP Singapore aerodrome chart gives
  for the control tower (01°21'33"N 103°59'22"E). At San Francisco the game puts it in the open space nearest the
  middle of the terminals. The cab is at about 72 m.
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
- Choose your own, with any number of runways landing and departing, in the runway step or with **Runways**.

The traffic mix is representative, not a real schedule, and the runway plans are
simplified. OSM is volunteer-mapped and can be incomplete or out of date. Never use
any of this for real-world navigation. Files: `data/traffic/<ICAO>.json` (airlines,
fleets, runway plans), `data/aircraft.json` (types), `data/osm/` (OSM extracts),
`data/hq/` (built layouts).

To refresh the layouts, run the **Tower game - fetch OpenStreetMap airport data**
workflow, or `python tools/fetch_osm.py` where the OSM servers are reachable, then
`node tools/build_hq.mjs`. The build prints a quality report: exits per runway, entries,
and whether every stand can reach every runway.

**Changi checked against the AIP Singapore aerodrome chart (AD-2-WSSS-ADC-2):** all 191 stands in the chart's
coordinate table are in the game with the right number, typically within 25 m of the chart's position (the game
parks at the end of the painted lead-in line). The one stand OpenStreetMap has that the chart doesn't, "209", is no
longer used.

### Beijing Daxing: one-way apron bays

Between the wings of the Daxing terminal each apron bay is a loop. **Aircraft come in on the straight lane through
the middle and leave on the curved lanes around it**, which they also use to reach their stand and to push back
onto:
- The straight lane is one-way from the bay entrance up to the head of the bay, and the curved lanes are one-way
  away from the head. So an arrival taxis in along the straight lane, turns onto a curve and into its stand; a
  departure pushes back onto a curve and leaves along it. Nobody meets head-on in a bay.
- Four bays are set up: Z8 with Z9/Z7 (stands 151–166), Y7 with Y8/Y6 (104–125), Y2 with Y3/Y1 (131–137, 180–184)
  and Z2 with Z1/Z3 (141–146, 192–197). They are listed under `flows` in `data/traffic/ZBAD.json`.
- Little arrows on the map (zoom in) show the direction of each one-way lane. Taxi routes, including ones you choose
  with **Choose route on map**, follow them; asking for a route against the flow gives "no taxi route".
- In OpenStreetMap the straight lanes of the NW and NE bays stop 60–100 m short of the loop, so the build joins
  them to it (`node tools/build_hq.mjs` says so). I placed the lanes and bays from the map shape and your description
  of the real layout, not from an official document: check them against the CAAC chart and tell me about any bay
  that works differently.
- At the other airports aircraft can use any lane both ways.

### Beijing Daxing: Chinese radio, metric units

At **ZBAD**, Chinese airlines work the tower in **Chinese**, as domestic flights do in China.

- **Callsigns** are Chinese: 南方 (China Southern), 东方 (China Eastern), 白鹭 (Xiamen Air), 联航 (China
  United), 首都 (Capital), 山东 (Shandong), 四川 (Sichuan), 吉祥 (Juneyao).
- **Numbers** are spoken the aviation way: 幺 1, 两 2, 拐 7, 洞 0.
- **Typical calls:** 「大兴塔台，南方3101，盲降跑道35右，18公里」, 「跑道35右，可以落地，南方3101」,
  「可以推出，预计跑道35右起飞」, 「经A、B2滑到跑道35左外等待点」, 「进跑道等待」, 「可以起飞」, 「联系离场，再见」.
- **Foreign airlines** (Aeroflot) use English.
- **Units:** wind in m/s, distances on final in km, speeds in km/h and heights in metres.

You can answer in Chinese by voice or typing, e.g. 「南方三幺洞幺，跑道三五右，可以落地」. A **中文 / EN** switch
next to the talk button sets the microphone language. It is Chinese by default at ZBAD, and English for Aeroflot.
Spoken Chinese needs a Chinese system voice (on iPad: Settings → Accessibility → Spoken Content → Voices →
Chinese). The Chinese wording is in `data/phraseology-zh.json`.

**Speech recognition for Chinese radio.** Browsers' Chinese recognisers don't know the radio digits and letters,
so they write things like 四川八九拐**舞** for 四川八九拐五 or **退**出 for 推出. The game cleans that up before
matching:
- **Digits:** 幺 洞 拐 两 and the ordinary ones, plus words that sound like a digit when they stand next to one
  (舞 午 伍 for 5, 角 酒 久 for 9, 怪 for 7, 动 冻 for 0, 腰 要 for 1, ...). Written numbers (3101, 3,101) work too.
- **Airline names** are found by sound (死川 is still 四川) and are never read as numbers (东方 isn't "0方").
  A clear call by airline and the last three digits (「山东幺洞幺」) is accepted.
- **Command words** are compared by sound, so 退出/推出, 起非/起飞, 跑到/跑道 and 又/右 all work.
- **Taxiway letters** can be said as Latin letters (A B2), as the Chinese letter sounds (诶 比 西 迪 伊 ... 贼),
  as code words (阿尔法 布拉沃 查理 ... 祖鲁, or English alpha bravo), or run together (AB2 is split into the
  airport's real taxiway names). 「经诶、比二、西幺滑到跑道17右外等待点」 is *via A, B2, C1*.
  The ICAO alphabet is also understood **inside Chinese sentences** (「经 Alpha Bravo 滑到跑道17右外等待点」,
  「滑行道阿尔法，然后布拉沃一」). A route can come in pieces (「经A，穿越跑道15，再经查理...」) and can include a
  stop: 「经A、B，在跑道15外等待」.
- **Several guesses:** the recogniser gives up to five guesses for what you said; the game tries them in order
  and uses the first that is a whole instruction (an aircraft and a command). This also helps in English.
- **When it still fails**, the radio log shows how the game read your words (「听成：四川8975 …」), so you can
  see which digit or letter was misheard.

The recogniser is the browser's, and accents or noise still cause errors that can't be fixed in the game. Tapping
the aircraft first means you only have to say the instruction. These tables are from general knowledge of
common misrecognitions; I have not tested them against real iPad or Chrome transcripts beyond the examples above.

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

## How close to real life

- **Separation:** ICAO wake-turbulence minima on final (e.g. heavy behind heavy 4 NM, medium behind heavy 5 NM) and
  between departures from one runway (2 to 3 minutes), plus radar minimum spacing. Departing with an arrival
  inside 2 NM of the same runway costs points.
- **Wind matters:** ground speed is airspeed minus the headwind, so arrivals close slower into a headwind and
  take-off rolls are shorter. Pilots **refuse** a landing or take-off clearance on a runway with more than 10 kt of
  tailwind or 30 kt of crosswind (*"unable, tailwind 14 knots is above our limit"*); choose the runways for the wind.
- **Approach speed:** arrivals slow from about 25 kt above their approach speed at 10 NM to it by 4 NM, like a
  real speed-controlled approach.
- **Taxiing:** about 20 kt on straights, 10 kt in normal turns and 6 kt in sharp ones; pushbacks give way to
  aircraft taxiing past; aircraft stop at the hold line of every runway they must cross until cleared.
- **Not modelled:** ATIS, clearance delivery, separate ground and tower frequencies, intersection departures,
  runway changes, gusts, wet runways and low-visibility procedures.

## Pilot voices

### Built-in voices: the same on every device

Turn on **Settings → Built-in voices** to make pilots sound the same on your iPad, PC and phone, whatever voices
those devices have installed. The game then speaks with free, open-source
[Piper](https://github.com/rhasspy/piper) neural voices that run inside the browser.

- **Variety:** over a thousand different pilot voices. Each airline gets fitting ones:
  - American carriers: American voices (904 speakers).
  - British, European and Australian carriers: voices from around the British Isles (109 speakers).
  - Chinese, Korean, Vietnamese, Indian, Arab and Spanish-speaking crews: English spoken with those accents
    (24 speakers recorded by non-native speakers).
  - Chinese crews at Daxing: one Chinese voice, varied in pitch per pilot.
- **Real radio sound:** the speech itself goes through an airband-radio filter (narrow band, a little
  overdriven, compressed), on top of the squelch and static.
- **Download, once per device:** the browser downloads what the airport's airlines need and keeps it for
  offline play:
  - Changi or Daxing: about 170–185 MB.
  - San Francisco and other airports: about 265 MB.
  - Later shifts at the same airport download nothing.
  - **Delete downloaded voices** frees the space.
- **Where it downloads from:**
  - The speech runtime from jsDelivr.
  - The voice models from Hugging Face. If Hugging Face is blocked, as in mainland China, it uses its mirror
    hf-mirror.com.
- **While downloading, or if it fails:** the device's own voices fill in.
- **Wait before speaking:** generating a call takes a moment. In a test on a desktop computer, a 5-second call
  took 1–2 seconds, and the next call is generated while the current one plays. Not yet measured on an iPad;
  an older one may make pilots answer a bit later.
- **Not part of this repository:** neither the voices nor the runtime are in the site's files. Credits and
  licences:
  - Piper voices from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), trained on LibriTTS-R
    (CC BY 4.0), VCTK (CC BY 4.0), L2-ARCTIC (CC BY-NC 4.0, non-commercial) and the Huayan Chinese dataset
    (see its model card).
  - ONNX Runtime Web (MIT).
  - Piper's phonemizer built for the web by Diffusion Studio (MIT), which includes eSpeak NG (GPL-3.0).

### Device voices

Without built-in voices, pilots speak with your device's own voices. To sound less like one robot:
- Each pilot gets one of the better voices on the device and keeps it. The game prefers "Premium",
  "Enhanced", "Natural", "Online" and Google voices, and never uses joke or old voices (Bells, Zarvox, Fred...).
- Each pilot has a different pitch and pace.
- **Accents:** pilots sound like they're from the airline's country, if your device has that voice.
  - British Airways pilots get a British voice, Qantas an Australian one, Air India an Indian one,
    Singapore Airlines a Singaporean or Indian one.
  - Lufthansa, Air France, KLM, JAL/ANA, Korean Air, Aeroflot and Chinese airlines speaking English get a
    German, French, Dutch, Japanese, Korean, Russian or Chinese voice reading the English call. That sounds
    like a pilot from there.
  - Turn it off under **Settings → Pilot accents**.
- **Different wordings:** pilots don't all say the same thing. A pushback request can be *"request pushback"*,
  *"ready for pushback"* or *"request push and start"*. A readback can be *"Cleared to land runway 27"* or
  *"Runway 27, cleared to land"*. There's a farewell on the frequency change, and so on. All are standard
  phrases. The wordings are lists in `data/phraseology.json` (and `-zh` for Chinese), so you can add your own.
- Pilots answer after a short pause, like people, instead of the instant you finish.
- **Radio sound:**
  - A squelch burst when a pilot keys the mic, static while they talk, and the squelch tail when they stop.
  - Each aircraft's radio sounds a bit different (click, tail, hiss colour); now and then one has a faint whistle.
  - Aircraft far out on final are weaker: more static, some crackle and a slightly quieter voice.
  - Your own instructions get a transmit click.
  - Turn it off under **Settings → Radio sound**.

The voices are only as good as the ones installed. For much better ones:
- **iPad / iPhone:** Settings → Accessibility → Spoken Content → Voices → English, then download an
  "Enhanced" or "Premium" voice (e.g. Ava, Zoe, Evan, Nathan, Serena); for ZBAD also a Chinese one.
- **Windows:** Microsoft Edge offers the "Online (Natural)" voices.
- **Chrome:** has Google voices built in.

The browser's speech can't be run through a radio filter itself (only the sounds around it), and how natural it
sounds on your device has not been measured.

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
TOWER_TEST_VOICES=<folder> node tools/e2e.mjs   # also tests built-in voices with local copies of their files
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
| `js/lib/` | small helpers: text/speech formatting, number words, runway choice, speech output and input, radio sounds, built-in voices (`neural.js`, `neural-worker.js`) |

## Speed and heat

The game is meant to run smoothly on a phone, an iPad and a laptop. To find out where the time went I played a busy
Daxing shift in headless Chromium with the CPU slowed to about a recent phone (`node tools/profile.mjs ZBAD 4`).
Before this work the map ran at **2.4 frames a second** (the main thread was 97% busy) and the 3D view at 1.5. Now the
map runs at **56 and the 3D view at about 19** in the same test. These numbers are from a computer with software
graphics, not from an iPhone or iPad, so they show what changed, not what your device will do.

What was slow, and what changed:
- **Blurred glass controls were the biggest cost.** Blurring what is behind a control is redone whenever that
  changes, and the map changes every frame. Removing it alone took the test from 20 to 56 frames a second.
  - Nothing blurs the map any more, and the slowly moving background is still.
  - **Settings → Visual effects:** *Fast* (flat controls, nearly the same look), *Full* (glass) or *Automatic*
    (Fast on touch devices, Full on a laptop).
- **The map was redrawn from scratch every frame**: Daxing has 15,000 taxiway segments. The still map is now drawn
  once into a hidden picture and copied each frame, and redrawn only when you zoom, pan, change theme or chart style, or
  change the runways. Segments are merged into long paths and points closer than a pixel are skipped. A full redraw
  went from about 55 ms to about 20 ms, and a normal frame from about 80 ms to under 1 ms. Panning and zooming move and
  scale the old picture and sharpen it when you stop. The cached picture is checked to be the same as a full redraw
  (`node tools/perf-check.mjs`).
- **The 3D view** was 209,000 triangles (a square and a disc for every taxiway segment) and used a logarithmic depth
  buffer and 4x anti-aliasing. Taxiways are now merged and simplified (53,000 triangles), the depth buffer is the plain
  one, anti-aliasing is only on laptop screens, and phones get a lower pixel density and the efficient GPU.
- **Route search** (taxi routes, the route preview) uses A* with a plain Dijkstra as a check in the tests: a route at
  Daxing takes 2 to 8 ms instead of 9 to 14. Taxi routes are no longer searched just to decide whether to show a button.
- **Drawing rate:** 20 pictures a second on touch devices at normal game speed (30 when fast-forwarding), the screen's rate
  on a laptop, every frame while you pan or zoom, and only when something changed while paused. The simulation always runs on real time. Side-panel text
  updates a few times a second.
- **The game tunes itself.** If the screen's frame rate stays under 25 a second while you play, it switches to Fast
  effects, then lowers the picture resolution, then draws 20 pictures a second, and says so in the radio log. (The
  30 fps of iOS Low Power Mode does not count as struggling.)
- The 3D engine (700 KB) is downloaded when you first open a 3D view, not with the page.
- **Built-in voices** (Settings) use much more battery and heat than the device's own voices, because the speech
  is generated on the device. If the device is still warm, turn them off.

Tools: `node tools/profile.mjs [ICAO] [cpu slowdown] [seconds] [map|orbit|tower]` (add `DESKTOP=1` for a laptop-style
browser) prints the frame rate, how busy the main thread was, the slowest operations and the 3D triangle count;
`node tools/perf.mjs [ICAO]` times one map frame; `node tools/perf-check.mjs` checks the cached map.

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

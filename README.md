# OpenATC

A free, local ATC companion for Microsoft Flight Simulator 2024 (Windows PC),
used on an iPad as an EFB. **Personal, simulation use only.** No paid APIs, no
accounts, no AI models, no commercial code, voices or content.

```
 Windows sim PC                                   iPad (Safari / Home Screen app)
 ┌──────────────────────────────┐   home Wi-Fi    ┌───────────────────────────────┐
 │ MSFS 2024                    │                 │ OpenATC web app               │
 │   │ SimConnect               │  HTTPS + WSS    │  - ATC state machine (rules)  │
 │ OpenATC helper (Python)      │◄───────────────►│  - phrase buttons, text, PTT  │
 │  - reads aircraft state 1/s  │  LAN only,      │  - speech synthesis           │
 │  - serves the web app        │  pairing token  │  - log, hints, flight plan    │
 │  - airports DB, METAR proxy  │                 └───────────────────────────────┘
 └──────────────────────────────┘
```

The helper does as little as possible on the sim PC: one SimConnect request per
second, a small web server, and lookups when you load a flight plan. All ATC
logic, the UI and speech run on the iPad.

---

## Contents

1. [Install on Windows](#1-install-on-windows)
2. [Set up the iPad (HTTPS certificate, pairing, Home Screen)](#2-set-up-the-ipad)
3. [Fly a flight](#3-fly-a-flight)
4. [Milestones: how to run and what to test](#4-milestones-how-to-run-and-what-to-test)
5. [Editing phraseology, airports and airlines](#5-editing-phraseology-airports-and-airlines)
6. [Command line](#6-command-line)
7. [Troubleshooting](#7-troubleshooting)
8. [Security model](#8-security-model)
9. [Assumptions and what could not be verified](#9-assumptions-and-what-could-not-be-verified)
10. [Limitations](#10-limitations)
11. [Development and tests](#11-development-and-tests)
12. [Credits and licences](#12-credits-and-licences)

---

## 1. Install on Windows

1. Install **64-bit Python 3.11, 3.12 or 3.13** from <https://www.python.org/downloads/windows/>.
   In the installer tick **"Add python.exe to PATH"**. (32-bit Python can't load
   `SimConnect.dll` and fails with `WinError 193`.)
2. Download this repository (green **Code** button → **Download ZIP**, then unzip),
   or `git clone` it. Put it somewhere simple, e.g. `C:\OpenATC`.
3. Double-click **`start_openatc.bat`**. The first run creates a private Python
   environment in `.venv` and installs three packages (`aiohttp`, `cryptography`,
   `SimConnect`). This needs internet once.
4. When Windows Defender Firewall asks whether Python may communicate on networks,
   tick **Private networks** only and **untick Public networks**, then **Allow access**.
   Your home Wi-Fi must be set to the *Private* network profile
   (Settings → Network & internet → Wi-Fi → your network → **Private network**).
5. Stop the helper (Ctrl+C or close the window) and double-click
   **`import_airports.bat`** once. It downloads the free OurAirports data
   (about 20 MB) and builds `userdata\ourairports.sqlite`. Re-run it every few months
   for updates.
6. Start `start_openatc.bat` again. The window shows something like:

   ```
    App on the iPad:   https://192.168.1.50:8443/
    First-time setup:  http://192.168.1.50:8080/   (install the certificate)
    CA fingerprint:    SHA-256 4E 72 FD 79 ...
    Pairing code:      482913
    Sim source:        simconnect
    Listening only on: 192.168.1.50, 127.0.0.1 (local network)
   ```

   Start it before or after MSFS, in any order. It reconnects by itself when the
   sim starts, quits or restarts.

> Tip: give the PC a fixed address in your router (DHCP reservation). If its
> address changes, the helper issues a new server certificate automatically
> (the iPad keeps trusting it), but you will need the new address on the iPad.

## 2. Set up the iPad

Safari only allows microphone and speech recognition on secure (HTTPS) pages.
OpenATC creates its own small certificate authority (CA) on your PC the first
time it starts (`userdata\certs`). You install that CA on the iPad once, and the
iPad then trusts the helper's HTTPS address. Nothing leaves your network and it
costs nothing.

Steps marked ⚠ could not be tried on a real iPad by the author (see section 9);
they follow Apple's documentation ([Apple support 102390](https://support.apple.com/en-ca/102390)).

**A. Install the certificate (once)**

1. iPad and PC on the same Wi-Fi. On the iPad open **Safari** (not another browser)
   and go to the *First-time setup* address from the helper window, e.g.
   `http://192.168.1.50:8080/`.
2. Tap **1. Download the OpenATC certificate**. Safari says *"This website is trying
   to download a configuration profile. Do you want to allow this?"* → **Allow** →
   **Close**. ⚠
3. Open the **Settings** app. Near the top, under your name, tap **Profile Downloaded**. ⚠
   (If it is not there: Settings → **General** → **VPN & Device Management** → the
   *OpenATC Local CA* profile.)
4. Tap **Install** (top right) → enter your passcode → **Install** → **Install** → **Done**. ⚠
5. Go to Settings → **General** → **About** → scroll to the bottom → **Certificate
   Trust Settings**. Under *Enable full trust for root certificates*, switch on
   **OpenATC Local CA (…)** → **Continue**. ⚠ Without this step Safari still
   shows "This Connection Is Not Private".
6. Optional check: Settings → General → VPN & Device Management → OpenATC profile →
   **More Details** → the certificate → SHA-256 must match the *CA fingerprint* in
   the helper window. ⚠

**B. Open the app and pair**

1. In Safari open the *App on the iPad* address, e.g. `https://192.168.1.50:8443/`.
   There must be no certificate warning. ⚠
2. Tap **Tap to start** (this tap also unlocks speech; Safari requires it).
3. Enter the 6-digit **pairing code** from the helper window → **Pair**. The iPad
   stores a token; you won't be asked again unless you unpair.

**C. Add to the Home Screen (optional)**

Safari → **Share** button → **Add to Home Screen** → **Add**. OpenATC then opens
full-screen like an app. ⚠ Reports say speech *recognition* may not work in Home
Screen web apps on some iPadOS versions; if push-to-talk does not work there,
use the normal Safari tab for voice. Buttons, typing and spoken ATC work in both.

**D. Recommended iPad settings**

- Settings → **Display & Brightness** → **Auto-Lock** → **Never** while flying
  (OpenATC also asks Safari to keep the screen on; that may not work everywhere).
- For voice input: Settings → **Apple Intelligence & Siri** (or **Siri**) → enable Siri, and
  Settings → **General** → **Keyboard** → **Enable Dictation** on. ⚠ Safari's
  speech recognition uses Apple's dictation service and may need internet.
- If you hear no speech: check the volume and that **Settings → Accessibility →
  Spoken Content** voices are downloaded (better voices: *Voices → English →
  pick one marked "Enhanced" or "Premium" and download it*). The voice list in
  OpenATC's Settings tab shows the voices the iPad offers.

## 3. Fly a flight

1. **Flight plan** tab: callsign (e.g. `CCA1234`), departure, arrival, cruise level
   (`FL350`, `350`, `35000`, or metric `10100m` / `S1010`), optional SID/STAR,
   approach type and phraseology (*ICAO generic* or *China (CAAC, metric)*).
   Under *More* you can force runways, stands, taxi routes, transition altitudes
   and any frequency. → **Start flight**.
2. OpenATC looks up both airports, fetches live METARs (NOAA), picks the runway
   most into the wind and shows a summary with all frequencies.
3. **Radio** tab:
   - The **Say next** card shows the call to make, and **Tune COM1 to …** when you
     are on the wrong frequency. Controllers only answer on their own frequency
     (switchable in Settings).
   - The big blue button is the most likely call; tap it. Readbacks are filled in
     for you. Or type a call (`request taxi`, `ready for departure`, `passing 3000
     climbing 5000`…), or hold **Hold to talk** and speak.
   - ATC replies appear in the log and are spoken. Tap a message to hear it again.
     Calls made while you were on another frequency appear greyed as *not heard*
     and are repeated when you tune in.
   - **Skip ahead** appears when OpenATC is waiting for something from the sim
     (airborne, reaching a level, distance to the airport) and lets you continue
     without the sim.

The flight follows: clearance delivery → push & start → taxi → holding point →
tower (take-off) → departure (radar contact, climb) → control (cruise level) →
descent (top of descent ≈ 3 NM per 1000 ft + 10 NM, or request it) → approach
→ approach clearance (≈ 18 NM) → tower (≈ 9 NM, landing clearance) → vacate →
ground (taxi to stand) → parking brake set = flight complete. Say *going around*
on approach/tower for a missed approach.

## 4. Milestones: how to run and what to test

All of these work without the simulator thanks to the **mock aircraft**
(`start_openatc.bat --mock`), which flies a scripted flight between the two
fictional demo airports `XDEP` and `XARR` (in `data/airports_manual.json`).

**(a) Helper reads the sim**
- Run `start_openatc.bat` with MSFS 2024 running and an aircraft loaded.
- Test: the helper window says *connected to the simulator*; on the iPad the **Sim**
  pill turns green and the **Data** tab shows position, altitude, heading, ground
  speed, COM1/COM2, transponder, parking brake, flaps and gear. Change COM1 and the
  transponder in the cockpit: the Data tab follows within about a second.
- Test reconnects: quit MSFS → pill shows *Sim offline* / waiting; start MSFS again →
  it reconnects without restarting the helper.

**(b) Web app shows live data on the iPad** — section 2. Test: Helper and Sim pills
  green, Data tab live; turn Wi-Fi off on the iPad → *Helper offline*; on again →
  reconnects by itself.

**(c) Rule-based ATC for one departure and one arrival**
- Run `start_openatc.bat --mock --mock-speed 10`. Flight plan tab →
  **Fill demo (XDEP to XARR)** → Start flight.
- Test: clearance, push, taxi, take-off, departure, control, descent, approach,
  landing, taxi-in all happen, with the mock aircraft moving on its own
  (Data tab → *Mock aircraft follows ATC*). Use **Tune (mock)** in the hint
  card to change the mock radio. Then fly a real short hop in MSFS with real
  airports after running `import_airports.bat`.

**(d) Phrase buttons and typed input** — tap the buttons; type calls such as
  `request push and start`, `holding point runway 27`, `request descent`,
  `established ILS runway 22`, `say again`, `radio check`. Try a wrong readback
  (leave out the squawk) → ATC corrects you.

**(e) Voice input/output** — Settings → *Test voice*; change voice/speed. Hold
  **Hold to talk**, say `request taxi`, release. If recognition fails 3 times
  in a row OpenATC turns voice input off and says why; buttons and typing keep
  working. Settings → Voice input shows what the iPad reports.

**(f) HTTPS** — section 2. Test: `https://` address opens without a warning;
  Settings → Voice input says *Speech recognition API found* (on plain HTTP it
  says voice needs the secure address).

## 5. Editing phraseology, airports and airlines

All texts are plain JSON. To keep your edits safe from updates, copy a file into
`userdata\` with the same sub-path; the helper serves your copy instead:

| Shipped file | Your copy | What it holds |
|---|---|---|
| `web/phraseology/icao.json` | `userdata/phraseology/icao.json` | ICAO generic phraseology |
| `web/phraseology/china.json` | `userdata/phraseology/china.json` | China, metric levels; *extends* icao |
| `web/data/airlines.json` | `userdata/data/airlines.json` | ICAO code → radio callsign |
| `data/airports_manual.json` | `userdata/airports_manual.json` | extra/overriding airports |

**Phraseology files.** Templates use `{placeholders}`; a part in `[square
brackets]` is dropped when one of its placeholders has no value (e.g. no SID);
`[stand {stand}|the apron]` picks the first alternative that has values. Sections:
`atc` (controller messages), `pilot` (button texts), `readback`, `buttons` (labels),
`intents` (regular expressions that recognise typed/spoken calls, checked top to
bottom), `units`, `numberWords`, `unitNames`, `defaults` (initial climb,
descent level, squawk range, default frequencies). A new region, e.g. Japan:
create `web/phraseology/japan.json` with `"extends": "icao"` and only the
differences, then add `<option value="japan">Japan</option>` to the Phraseology
list in `web/index.html`. Reload the app; errors in the file are shown when you
start a flight. Placeholders available: `callsign unit arrival sid star runway
initial_alt squawk qnh wind atis approach stand taxi_route facing good_day level
next_unit next_freq cleared altitude freq items squawk_check`.

**Manual airports** (airports OurAirports lacks, or fixes):

```json
{ "airports": {
  "ZZZZ": {
    "name": "My Strip", "municipality": "Hometown", "lat": 31.1, "lon": 121.3, "elevation_ft": 20,
    "runways": [ { "le_ident": "09", "he_ident": "27", "length_ft": 8000,
                   "le_lat": 31.1, "le_lon": 121.29, "le_heading": 90,
                   "he_lat": 31.1, "he_lon": 121.31, "he_heading": 270 } ],
    "frequencies": { "DEL": "121.650", "GND": "121.900", "TWR": "118.700", "APP": "119.250", "CTR": "128.500" },
    "names": { "TWR": "Hometown Tower" }
  } } }
```

Runway coordinates are optional (used for "arrived at the holding point" and
distance-to-runway); headings default to the runway number × 10. Frequencies
listed replace OurAirports' for that role. Missing frequencies fall back:
Delivery → Ground → Tower; Departure ↔ Approach → en-route control; anything
still missing uses the region default (shown in the log).

## 6. Command line

`start_openatc.bat [options]` or `.venv\Scripts\python -m openatc [command] [options]`

| | |
|---|---|
| `run` (default) | start the helper |
| `import-airports [--from-dir DIR]` | build the OurAirports database (download, or from CSVs in DIR) |
| `show-pairing` | print the pairing code |
| `reset-pairing` | new pairing code, forget all paired devices |
| `--mock`, `--mock-speed N` | simulated aircraft instead of MSFS (N = time multiplier) |
| `--no-sim` | no simulator source at all (use Skip ahead) |
| `--rate N` | sim reads per second, 0.2–5 (default 1) |
| `--simconnect-dll PATH` | use another `SimConnect.dll` (e.g. from the MSFS 2024 SDK) |
| `--bind IP` | LAN address to listen on (default: auto-detect; must be private) |
| `--port 8443`, `--setup-port 8080` | HTTPS app port; plain-HTTP certificate page (0 = off) |
| `--no-https` | plain HTTP (testing only; voice input will not work in Safari) |
| `--offline` | never fetch METAR |
| `--data-dir DIR` | where settings, certificates and data are kept (default `userdata`) |
| `-v` | verbose logging |

## 7. Troubleshooting

**Windows / helper**

| Problem | Fix |
|---|---|
| `python` not found when running the .bat | Reinstall Python with "Add python.exe to PATH", or install the `py` launcher (default in the python.org installer). |
| `WinError 193` | 32-bit Python. Install 64-bit Python, delete the `.venv` folder, run the .bat again. |
| Sim pill stays red, helper says *waiting for the simulator* | MSFS not running, or still on the loading screen. Wait for the main menu. If it never connects, try `--simconnect-dll "C:\MSFS 2024 SDK\SimConnect SDK\lib\SimConnect.dll"` (install the SDK from the MSFS Developer Mode menu). Run the helper as the same Windows user as MSFS (not "as administrator" unless MSFS is). |
| *connected, waiting for a flight to load* | Normal in the main menu. Data starts when you are in the aircraft. |
| *block request rejected by the sim; using per-variable requests* | One SimVar name was not accepted. Data still works (slightly more CPU); please note which values stay "-" in the Data tab. |
| iPad can't open the address | Same Wi-Fi? Windows network set to **Private**? Firewall: Windows Security → Firewall & network protection → Allow an app through firewall → *python.exe* ticked for **Private**. The helper only listens on the address it prints; if the PC has several adapters (VPN, Ethernet + Wi-Fi) pass `--bind` with the Wi-Fi address (`ipconfig`). |
| *No local network address found* | The PC isn't on a private network (or only on a VPN). Connect to your home network or use `--bind`. |
| *OurAirports data not imported* / unknown airport | Run `import_airports.bat`. For airports not in OurAirports, add them to `userdata\airports_manual.json`. |
| No METAR / *weather service unreachable* | PC offline, or the station publishes no METAR. OpenATC uses your runway choice or the longest runway and leaves wind/QNH out. |
| Lost the pairing code | `.venv\Scripts\python -m openatc show-pairing` (or look in the helper window). |
| Sim stutters | Try `--rate 0.5` (one read every 2 s). CPU use on a real sim PC has not been measured. |

**iPad**

| Problem | Fix |
|---|---|
| "This Connection Is Not Private" | Step 2A.5 (Certificate Trust Settings) not done, or you opened the `http://…:8080` page instead of `https://…:8443`. If you deleted `userdata\certs`, a new CA was made: remove the old profile on the iPad and install the new one. |
| *Profile Downloaded* not in Settings | You used Chrome/another browser; use Safari. Or it was dismissed: Settings → General → VPN & Device Management. |
| Asked for the pairing code again | The token was cleared (Safari *Clear History and Website Data*, or a different address/port = different origin). Pair again. |
| No ATC voice | Tap *Tap to start* after every reload (Safari rule). Check volume, Settings → Speech output, and *Test voice*. Speech stops when the iPad locks or Safari is in the background. |
| Push-to-talk does nothing / *voice input switched off* | Must be the `https://` address. Turn on Siri and Dictation. Try in a Safari tab rather than the Home Screen app. Allow the microphone when asked (Settings → Apps → Safari → Microphone, or Settings → Safari → Microphone on older iPadOS) ⚠. Use buttons or typing meanwhile; voice is optional. |
| Recognition mishears callsigns/numbers | Speak digits individually ("one two one decimal niner"), or enable *Put recognised text in the text box* to correct before sending. |
| Controllers don't answer | Check the *Tune* hint and that the right radio is selected (Settings → Transmit on). Turn off *Controllers only answer on their own frequency* to ignore radios. |
| Stuck waiting for an event | Use **Skip ahead**. Or start a new flight plan. |

## 8. Security model

- The helper listens **only on its private LAN address and 127.0.0.1**, never on
  0.0.0.0, and refuses to start on a public address. Every request from an address
  that is not loopback/private/link-local is refused (403). It never opens router
  ports (no UPnP). Don't forward ports to it.
- Pairing: a 6-digit code (shown only in the helper window) is exchanged once for
  a random 256-bit token. Only a SHA-256 hash of the token is stored on the PC.
  After 5 wrong codes, pairing is locked for 10 minutes. All APIs and the
  WebSocket require the token; the WebSocket sends it in the first message, not
  in the URL.
- The plain-HTTP port (8080) serves only the public CA certificate and an
  instructions page. The CA private key stays in `userdata\certs` on the PC: keep
  that folder private; anyone with `openatc-ca.key` could make certificates your
  iPad trusts. To revoke: delete the profile on the iPad (Settings → General → VPN &
  Device Management) and delete `userdata\certs`.
- The only outbound connections are to `aviationweather.gov` (METAR) and, when you
  run the import, `davidmegginson.github.io` (OurAirports CSVs).

## 9. Assumptions and what could not be verified

The code was written and tested on Linux (no Windows, no MSFS, no iPad available
to the author). What was tested is listed in section 11. Everything below is
**not verified on the real target**:

**SimConnect with MSFS 2024**
- Library: [`SimConnect` 0.4.26 on PyPI](https://pypi.org/project/SimConnect/)
  (odwdinc/Python-SimConnect), which bundles the **MSFS 2020 SDK** `SimConnect.dll`.
  I found **no statement from the project itself that it supports MSFS 2024**.
  Microsoft's [MSFS 2024 SimConnect SDK docs](https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimConnect/SimConnect_SDK.htm)
  say a client built with the MSFS 2020 SDK is detected as a 2020 client and keeps
  working (without 2024-only features; the known exception is airport facility data,
  which OpenATC does not use). A third-party MSFS 2024 tool reports using this
  package. **Not verified by running it.**
  Fallback: `--simconnect-dll` with the DLL from the MSFS 2024 SDK.
- OpenATC uses its own single multi-variable request on top of the library
  (one packet per poll). The struct handling follows the SimConnect SDK and the
  library's own code; it has only been tested against a fake library. If MSFS
  rejects it, OpenATC switches to the library's per-variable requests by itself.
- SimVar names/units used: `PLANE LATITUDE/LONGITUDE`, `PLANE ALTITUDE`,
  `PLANE ALT ABOVE GROUND`, `INDICATED ALTITUDE`, `PLANE HEADING DEGREES MAGNETIC/TRUE`,
  `GROUND VELOCITY`, `AIRSPEED INDICATED`, `VERTICAL SPEED`, `SIM ON GROUND`,
  `COM ACTIVE/STANDBY FREQUENCY:1/2` (MHz), `TRANSPONDER CODE:1` (BCO16),
  `BRAKE PARKING POSITION`, `FLAPS HANDLE INDEX`, `GEAR HANDLE POSITION`.
  Assumed unchanged in MSFS 2024. Some add-on aircraft use their own radios and
  may not update the standard COM/transponder variables.
- Assumed `Python-SimConnect` does not need MSFS to run as administrator.

**iPad Safari speech**
- Speech recognition: Safari exposes `webkitSpeechRecognition` since iOS/iPadOS 14.5.
  Reports (Apple developer forums, compatibility tables) say it is unavailable
  or broken in Home Screen web apps on several versions, needs Siri/Dictation,
  and that continuous mode has hung on iPad. I could not test on an iPad. OpenATC
  detects absence/failure and falls back automatically. **Tested only in desktop
  Chromium** (headless), where the API exists.
- Speech synthesis: the first utterance must start from a tap (*Tap to start*).
  Voice list, rates and the per-controller voices are iPad-dependent. Not tested on iPad.
- Screen Wake Lock (Safari 16.4+): assumed; harmless if unsupported.

**HTTPS trust on iPad**
- Steps follow Apple's article [102390](https://support.apple.com/en-ca/102390) and
  Apple's certificate requirements for iOS 13+ (RSA 2048+, SHA-256, SAN, serverAuth
  EKU, ≤ 825 days; OpenATC uses 397 days). Downloading a `.cer` from Safari opening
  the profile installer, and the exact Settings labels, are as documented by Apple but
  **not tried by the author** (marked ⚠ above). Labels can differ slightly between
  iPadOS versions.
- The certificate itself was verified with Python's `cryptography` (chain, SAN, EKU,
  validity) and served over TLS to Chromium in the end-to-end test.

**Data and phraseology**
- OurAirports CSV columns as published in 2026 (`airports.csv`, `runways.csv`,
  `airport-frequencies.csv`); the import is tested with fixture files, the real
  download could not be run from the build machine (network blocked).
- NOAA AWC API `https://aviationweather.gov/api/data/metar?format=json` field names
  (`rawOb`, `wdir`, `wspd`, `wgst`, `altim`, `reportTime`); wind and QNH are taken
  from the raw METAR text first, so field-name changes have limited effect. Not reached
  from the build machine.
- Phraseology is ICAO-*style*, simplified for a single-pilot sim (no traffic, no
  real SID/STAR data, no taxiway routes). The China file's metric flight-level table
  and English CAAC wording are from general knowledge: **check against the CAAC AIP**.
- Default levels (initial climb 5000 ft / 900 m, departure climb FL150 / 6000 m,
  descent FL100 / 3600 m, approach 3000 ft / 900 m), the 5000 ft ICAO transition
  altitude and the default frequencies (tower 118.100, control 127.500) are
  arbitrary but editable in the phraseology file / flight plan.
- ATIS letter is derived from the METAR hour (A–Z); it is not real ATIS.
- Airline telephony list is short and from public knowledge.

## 10. Limitations

- No AI traffic, no conflicts, no vectors or holding; one aircraft, one flight at a time.
- No taxi routing (OurAirports has no taxiways); give taxi routes in the flight plan if wanted.
- Holding-point detection needs runway threshold coordinates (OurAirports has them
  for most larger airports).
- ATC logic pauses when the iPad sleeps or Safari is in the background (it runs on
  the iPad); it resumes from saved state when you return.
- Japan or other regions: add a phraseology file (section 5).

## 11. Development and tests

```
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest          # helper: pairing, certificates, airports import, METAR parsing,
                                    #   server auth/LAN-only/WebSocket, mock flight, SimConnect reconnect
npm test                            # web: formatter, parser, runway choice, phraseology files,
                                    #   whole ICAO and China flights through the ATC engine
node tools/e2e.mjs                  # helper (--mock, HTTPS) + headless Chromium: pair, live data,
                                    #   demo flight to radar contact with buttons and typed input
```

No build step: the web app is plain HTML/CSS/ES modules in `web/`. Layout:

```
openatc/            Python helper (aiohttp server, SimConnect/mock sources, certs, pairing, data)
web/                iPad web app; web/js/atc/ = ATC engine (no DOM, tested in Node)
web/phraseology/    editable phraseology files
data/               shipped manual airports (demo XDEP/XARR)
userdata/           created at runtime: pairing, certificates, airport DB, your overrides (git-ignored)
tests/, web/tests/  tests; tools/ e2e test and icon generator
```

## 12. Credits and licences

- Airport data: [OurAirports](https://ourairports.com/data/), public domain.
- Weather: NOAA [Aviation Weather Center data API](https://aviationweather.gov/data/api/), US government, free.
- `SimConnect` Python package (odwdinc/Python-SimConnect) is AGPL-3.0; it is
  installed as a dependency, not copied into this repository. `SimConnect.dll`
  is Microsoft's, from the MSFS SDK.
- `aiohttp` (Apache-2.0), `cryptography` (Apache-2.0/BSD).
- OpenATC itself contains no code, voices, branding or content from any commercial
  ATC product. Voices are the iPad's own system voices.
- Not for real-world aviation. Simulation use only.

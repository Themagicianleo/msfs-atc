# Tower Controller for Mac (Apple Silicon)

The tower game in its own window. It is the same game as the web version (the files are inside the app), with a proper window
and menu, the microphone, and room for engines a browser cannot run (better voice recognition and its own voices: later steps).
Apple Silicon (M1 and later) only.

## Get it

GitHub → this repository → **Actions** → *Tower Controller for Mac (Apple Silicon)* → **Run workflow**. When it has finished,
**Releases** → *desktop-latest* has `Tower-Controller-arm64.dmg` (and a `.zip`).

## First launch (the app is not signed with an Apple Developer ID)

CI signs it "ad hoc", which Apple Silicon needs in order to run it, but macOS still asks you to allow an app from the internet
that has no paid developer signature. Once:

1. Open the `.dmg`, drag **Tower Controller** to **Applications**.
2. Open it from Applications. macOS says it can't verify it. Close that box.
3. **System Settings → Privacy & Security**, scroll down, **Open Anyway** next to *Tower Controller*, confirm.

Or, in Terminal, once (this removes the "downloaded from the internet" mark):

```bash
xattr -dr com.apple.quarantine "/Applications/Tower Controller.app"
```

## Voice input

The browser's own recogniser does not work inside an app like this, so voice input uses the AI model (Settings → AI voice
recognition, on by default here; one download, then offline). The first press of **Start talking** makes macOS ask for the
microphone. Until the model has downloaded, type or use the buttons.

## Build it yourself

```bash
cd tower-game && python3 tools/build_airports.py && node tools/build_hq.mjs   # the airports
cd ../desktop && npm install && npm run site && npm start                      # try it (npm run site copies the game into app/)
npm run pack                                                                   # the .app, in dist/ (on a Mac)
```

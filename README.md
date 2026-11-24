# Hindi Captions

Live Hindi captions for any English audio playing on a Windows PC: Zoom, Google Meet, Teams, YouTube, anything. It does not use any meeting-app API. It listens to what the speakers play.

## How it works
System audio (WASAPI loopback) -> speech-to-text -> Gemini translation -> Hindi caption bar on screen.

- **Speech-to-text:** our ASR hub when it is reachable with a key. Otherwise Gemini transcribes the audio with the user's own key.
- **Translation:** Gemini (`gemini-2.5-flash`, thinking off), with the last two sentences sent as context.
- **Captions** appear about 4 seconds after the speech.

## Use
1. Get a free Gemini API key at https://aistudio.google.com/apikey.
2. Run `Hindi Captions.exe`. On first run, paste the key and click **Save**. The key is stored encrypted, on that PC only.
3. Click the purple **हि** button on the right edge of the screen to start.
   - **Pause / Resume** stop and restart listening.
   - **End** finishes the meeting. **Download** then saves Hindi + English as `.txt`, or as `.srt` subtitles.
   - **Mic** also translates your own voice. It is off by default. Use headphones when it is on.
   - **–** hides the panel and keeps listening.
   - **✕** quits. If you have not downloaded yet, it asks first.

Every session is also autosaved to `%APPDATA%\Hindi Captions\sessions\`.

## Run from source
```
npm install
npm start
```
On Windows, clear `ELECTRON_RUN_AS_NODE` first if it is set (VS Code sets it). `start.cmd` does this for you.

## Settings
`%APPDATA%\Hindi Captions\config.json` holds `hubUrl`, `geminiModel` and `hideFromScreenShare`. When `hideFromScreenShare` is true, the caption windows are hidden from Zoom screen share.

## Privacy
Audio goes to the ASR hub, or to Google when Gemini transcribes it. The text goes to Google for translation, under the user's own key.

## Known limits
- Free Gemini keys have per-minute and per-day limits. Long meetings may hit them.
- All PC audio is captured, so mute other sounds during a meeting.
- The exe is unsigned, so Windows SmartScreen shows "More info → Run anyway".
- Test hooks (`LHC_*` environment variables) only run when they are set.

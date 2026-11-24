# Hindi Captions

Live Hindi captions for any English audio playing on a Windows PC: Zoom, Google Meet, Teams, YouTube, anything. It does not use any meeting-app API. It listens to what the speakers play.

## How it works
System audio (WASAPI loopback) -> speech-to-text -> Gemini translation -> Hindi caption bar on screen.

- **Speech-to-text:** our ASR hub when it is reachable with a key. Otherwise Gemini transcribes the audio with the user's own key.
- **Translation:** Gemini (`gemini-2.5-flash`, thinking off), with the last two sentences sent as context.
- **Captions** appear about 4 seconds after the speech.

## Download (Windows)
The app is **not** in the repository files. It is a separate download:

1. Open **[Releases → latest](https://github.com/24pai001-ritik/zoom/releases/latest)** and download **`HindiCaptions.zip`** (about 100 MB).
2. Right-click the zip, choose **Extract All**, and open the extracted `HindiCaptions` folder. Don't run it from inside the zip.
3. Double-click **`Hindi Captions.exe`** in that folder. If Windows shows "Windows protected your PC", click **More info → Run anyway**.

## Use
1. Get a free Gemini API key at https://aistudio.google.com/apikey.
2. On first run, a setup window opens. Paste the key and click **Save**. The key is stored encrypted, on that PC only.
3. Click the purple **हि** button on the right edge of the screen to start.
   - **Pause / Resume** stop and restart listening.
   - **End** finishes the meeting. **Download** then saves Hindi + English as `.txt`, or as `.srt` subtitles.
   - **Mic** also translates your own voice. It is off by default. Use headphones when it is on.
   - **–** hides the panel and keeps listening.
   - **✕** quits. If you have not downloaded yet, it asks first.

Every session is also autosaved to `%APPDATA%\Hindi Captions\sessions\`.

## Run from source (developers)
Needs Node.js. This runs the same app without the exe:
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

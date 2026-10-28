# Voice Claude

Hands-free Claude for walks. Long-press the earbud, ask a question, hear the answer, keep talking. No touching the phone.

Android only (built and tested for a Samsung Galaxy A54 with Anker Soundcore earbuds).

## How it works

| Piece | What it does |
| --- | --- |
| `modules/voice-assistant` | Local Expo module (Kotlin). Registers the app as an Android **digital assistant** (`VoiceInteractionService`), so the earbud long press, which sends the Bluetooth "voice recognition" command, opens Voice Claude instead of Gemini. Also catches `ASSIST` / `VOICE_COMMAND` intents, routes the mic to the earbuds over Bluetooth SCO, and runs a microphone foreground service so it keeps working with the screen off. |
| `src/stt.ts` | Streams 16 kHz PCM from `expo-audio` to Deepgram (nova-3) over a WebSocket. A turn ends after about 1 s of silence. |
| `src/claude.ts` | Claude Messages API, streamed (`@anthropic-ai/sdk` + `expo/fetch`), with web search and a "spoken answers" system prompt. |
| `src/tts.ts` | Speaks the reply sentence by sentence with Android's built-in TTS (`expo-speech`) while Claude is still writing. |
| `src/conversation.ts` | Turn-taking: listen, think, speak, listen again. Ends after 30 s of silence. |
| `src/network.ts` | Watches the native connectivity signal and runs the speed probe until the link is usable. |
| `src/notes.ts` | Records voice notes while offline and hands the Deepgram transcript to a new chat once signal returns. |
| `src/slack.ts`, `src/light-mode.ts` | Slack light-voice mode: reads an agent's thread aloud and posts your spoken reply. |

### Controls

- **Earbud long press while idle:** start a new chat ("Yes?").
- **Long press while Claude is talking or thinking:** interrupt and listen.
- **Long press while it's listening:** start over with a new chat.
- **Say "stop", "bye", or "that's all"** (alone, or at the end of a sentence)**:** end. **Say "new chat":** start over.
- **Long press while there is no signal:** start recording a note; press again to stop (3 min max).

## Signal loss (trail runs)

Weak signal only drops words. A full drop used to end the session; now:

- **Claude-app mode:** walk mode's accessibility service watches connectivity. If the link dies while a Claude voice chat is live, it waits for the link to come back, runs a small speed probe against Cloudflare (latency under 1 s, 150 kbps down, 50 kbps up, every 30 s), plays two rising beeps and reopens the same chat in the Claude app, tapping voice mode again. After 20 minutes it gives up with three falling beeps: take the phone out and start over. Meanwhile whatever you were listening to before resumes on its own (Android audio focus). With no chat pending, one short pip after an outage means a new session could be started now.
- **Voice Claude mode:** the conversation parks in "No signal, waiting…" with its history intact and resumes the same chat ("Back.") once the probe passes; an unanswered question is re-sent. Claude requests retry three times with backoff.
- **Offline notes:** while there is no signal the earbud press records a note to the phone instead (double beep at start and stop). When the link is usable again the notes are transcribed with Deepgram and opened as a fresh chat: "Notes I took while offline: …". In Claude-app mode the text is shared into the Claude app and voice mode is started.

Thresholds and intervals live in `SpeedProbe.kt` and `src/network.ts`.

## Slack light-voice mode

Local Claude Code agents post questions to Slack threads with a link button `voiceclaude://thread/<channel>/<ts>`. Tapping it (also from the lock screen) makes Voice Claude read the thread aloud ("Alice: …", last five messages) and ask "Your reply?". Say your answer and it is posted to the thread; say **skip**, **repeat**, or **open this in Claude** to hand the thread to a full Claude session. Links that arrive mid-conversation are queued with a pip and read once the chat ends. Needs a Slack token (scopes `chat:write`, `channels:history`/`groups:history`/`im:history`, optionally `users:read` and `channels:read`) and the Deepgram key in Settings.

## Setup

You need a development build. Expo Go can't load the native module.

```bash
npm install
APP_VARIANT=development npx expo run:android   # phone plugged in with USB debugging, or:
npx eas-cli@latest build --profile development --platform android
```

`APP_VARIANT=development` (set automatically by the EAS `development` profile) builds the dev client as **Voice Claude (Dev)** under the package `com.bartelspeter.voiceclaude.dev`, so it installs next to the Play build instead of replacing it. Each app keeps its own keys, and only one of them can be the assistant app or have walk mode switched on at a time. A local build needs JDK 17 and the Android SDK (`ANDROID_HOME`); after switching variants run `npx expo prebuild --platform android --clean` with the same `APP_VARIANT` before `expo run:android`.

Then on the phone:

1. Open Voice Claude and enter your Anthropic API key and Deepgram API key (stored in the Android keystore through `expo-secure-store`).
2. Tap the banner, or go to **Settings > Apps > Choose default apps > Digital assistant app**, and pick **Voice Claude**.
3. In the Soundcore app, make sure the right-earbud long press is set to **Voice assistant**.
4. Tap **Allow** on the "Let Voice Claude run with the screen off" banner and accept the battery-optimisation exemption. Android only lets the microphone service start from a pocket when the app is exempt; without it the app lights the screen for a few seconds instead.
5. Long-press the earbud. The screen stays off and locked during the chat.

## Things to verify on the device

- The earbud long press reaches the assistant session, not just the Settings page (that's what happened with the official Claude app).
- Earbud mic over SCO actually beats the phone mic in street noise. You can turn it off in Settings.
- Behavior on the lock screen and with the screen off.

## Walk mode and banking apps

Thai banking apps (KBank and others) refuse to run while a sideloaded app has an accessibility service switched on. **Walk mode** is that service: turn it off before banking, back on before a walk.

- Switch on Voice Claude's main screen, the **Walk mode** Quick Settings tile (add it by editing the Quick Settings panel), or long-press the app icon for **Walk mode on / off**.
- For the app to flip the setting itself, Android needs a one-time grant from a computer (redo it after reinstalling the app):

  ```
  adb shell pm grant com.bartelspeter.voiceclaude android.permission.WRITE_SECURE_SETTINGS
  ```

  (`com.bartelspeter.voiceclaude.dev` for the dev build.) Without it, the switches open the Accessibility settings screen instead.

## Release builds (EAS + Google Play)

`eas.json` has three profiles:

| Profile | What it builds |
| --- | --- |
| `development` | Dev client APK that loads JS from Metro (what we've been sideloading). |
| `preview` | Standalone release APK with the JS bundle inside. No dev server needed. |
| `production` | App bundle for Google Play. `eas submit` sends it to the **internal testing** track. |

First-time setup (on your computer, logged in to your own accounts):

```
npx eas-cli@latest login
npx eas-cli@latest init                      # links the project to your Expo account
npx eas-cli@latest build -p android --profile production
```

Then create the app in the [Play Console](https://play.google.com/console) (**Create app**, name "Voice Claude", package is taken from the first upload) and submit:

```
npx eas-cli@latest submit -p android --profile production --latest
```

EAS Submit can do the first upload itself. It uses a Play service-account key saved as `google-play-service-account.json` (gitignored); create one with [Expo's guide](https://github.com/expo/fyi/blob/main/creating-google-service-account.md) and invite its e-mail under **Users and permissions** in the Play Console. The release lands on **Testing › Internal testing**; add yourself as a tester there and install from the opt-in link.

Before the app can leave internal testing, the Play Console dashboard tasks need finishing. Copy-paste text for them is in [`store/play-listing.md`](store/play-listing.md), and the privacy policy Play asks for (microphone apps need one) is [`PRIVACY.md`](PRIVACY.md), served from this public repo. Two declarations need a short screen recording: the **accessibility service** (walk mode) and the **microphone foreground service**.

Because Play re-signs the app, uninstall the sideloaded build before installing from Play. Then repeat the walk-mode `adb` grant and switch the accessibility service on again.

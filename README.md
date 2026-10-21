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

### Controls

- **Earbud long press while idle:** start a new chat ("Yes?").
- **Long press while Claude is talking or thinking:** interrupt and listen.
- **Long press while it's listening:** start over with a new chat.
- **Say "stop", "bye", or "that's all":** end. **Say "new chat":** start over.

## Setup

You need a development build. Expo Go can't load the native module.

```bash
npm install
npx expo run:android          # phone plugged in with USB debugging, or:
npx eas-cli@latest build --profile development --platform android
```

Then on the phone:

1. Open Voice Claude and enter your Anthropic API key and Deepgram API key (stored in the Android keystore through `expo-secure-store`).
2. Tap the banner, or go to **Settings > Apps > Choose default apps > Digital assistant app**, and pick **Voice Claude**.
3. In the Soundcore app, make sure the right-earbud long press is set to **Voice assistant**.
4. Long-press the earbud.

## Things to verify on the device

- The earbud long press reaches the assistant session, not just the Settings page (that's what happened with the official Claude app).
- Earbud mic over SCO actually beats the phone mic in street noise. You can turn it off in Settings.
- Behavior on the lock screen and with the screen off.

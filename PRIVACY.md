# Voice Claude privacy policy

_Last updated: 23 October 2026_

Voice Claude is a hands-free voice assistant for Android, published by Peter Larsson. This policy explains what the app does with your data.

## What the app collects

- **Your voice.** When you start a conversation (earbud long press), the app records audio from the microphone and streams it to **Deepgram** for speech-to-text. Recording stops when the conversation ends. Audio is not stored on the phone.
- **Your questions and the answers.** The transcribed text is sent to **Anthropic's Claude API**, which may perform web searches to answer. The app keeps the current conversation in memory only and discards it when the conversation ends.
- **API keys.** The Anthropic and Deepgram keys you enter are stored in the Android keystore on your device and are sent only to those two services.

The app has no account system, no analytics, no advertising, and no server of its own. Nothing is sent to the developer.

## Third parties

Audio goes to Deepgram and text goes to Anthropic over encrypted (TLS) connections, under the API keys you supply. Their handling of that data is governed by their own policies:

- Deepgram: https://deepgram.com/privacy
- Anthropic: https://www.anthropic.com/privacy

## Android permissions

- **Microphone** and **microphone foreground service**: to listen while the screen is off or the app is in the background during a conversation.
- **Bluetooth connect**: to route the microphone to your earbuds.
- **Notifications**: to show the ongoing-conversation notification Android requires for background recording.
- **Accessibility service ("Walk mode")**: used only when you choose the optional "Claude app" mode, to tap into a new voice chat in the official Claude app after the earbud press. It acts only inside the Claude app, only for a few seconds after an earbud press, and never reads or stores content from other apps. You can switch it off at any time from the app, the Quick Settings tile, or Android's Accessibility settings.
- **Digital assistant role**: so the earbud "voice assistant" button opens Voice Claude.

## Deleting your data

Uninstalling the app removes the stored API keys and everything else. To delete data held by Deepgram or Anthropic, use the controls in your accounts with those services.

## Contact

peter@bartelsinternational.com

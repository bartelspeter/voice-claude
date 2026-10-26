# Google Play listing and declarations

Copy-paste material for the Play Console dashboard tasks. Edit freely.

## Status

Done in the repo:

- [x] Store listing text (below).
- [x] Privacy policy: [`PRIVACY.md`](../PRIVACY.md), public at the URL below (repo is public, link checked 25 Oct 2026).
- [x] App icon 512x512 (`store/icon-512.png`, exported from `assets/icon.png`). It is still the Expo template chevron; replace `assets/icon.png` and re-export if you want a real one before the listing goes public.
- [x] Feature graphic 1024x500 (`store/feature-graphic.png`).
- [x] In-app prominent disclosure for the accessibility service (commits 3c0a290 and 9c37d49). Text is quoted in the declaration section below.
- [x] Declaration answers for accessibility, foreground service and data safety (below).

Captured on the A54 on 26 Oct 2026 with `store/record.sh` (re-run `./store/record.sh <stage>` to redo one):

- [x] Phone screenshots: `store/screenshots/01-walk-mode-disclosure.png`, `store/screenshots/02-conversation.png`.
- [x] Accessibility declaration video: `store/videos/accessibility-service.mp4` (local only, gitignored).
- [x] Foreground service declaration video: `store/videos/microphone-foreground-service.mp4` (local only, gitignored; no audio track, adb screenrecord cannot capture it).
- [ ] Decide whether to give reviewers test API keys under App access › Instructions (see below).
- [ ] Upload everything in the Play Console and submit the declarations.

## Store listing

**App name:** Voice Claude

**Short description (max 80 chars):**
Hands-free Claude for walks. Long-press your earbud, ask, listen, keep talking.

**Full description:**
Voice Claude turns your Bluetooth earbuds into a hands-free line to Claude. Set it as your phone's digital assistant, then long-press the earbud: the app listens, sends your question to Claude, and reads the answer aloud while it is still being written. Keep talking, interrupt, or say "that's all" to stop. The phone stays in your pocket.

- Works with the screen off and on the lock screen
- Uses the earbud microphone over Bluetooth so it hears you in street noise
- Streams speech to text (Deepgram) and answers from Claude with web search
- Speaks replies sentence by sentence with Android's built-in voices
- Walk mode Quick Settings tile to switch the optional accessibility service on and off

Bring your own API keys: you need an Anthropic API key and a Deepgram API key. They are stored in the Android keystore and never leave your phone except to those two services. There is no account, no analytics and no ads.

Not affiliated with Anthropic.

**Category:** Productivity
**Tags:** voice assistant, AI
**Contact e-mail:** peter@bartelsinternational.com
**Privacy policy URL:** https://github.com/bartelspeter/voice-claude/blob/main/PRIVACY.md

**Graphics:** `store/icon-512.png` (app icon, 32-bit PNG with alpha), `store/feature-graphic.png` (1024x500), screenshots in `store/screenshots/`.

## App content declarations

**Privacy policy:** URL above.

**Ads:** No, the app contains no ads.

**App access:** All functionality is available without special access. Note: "The app requires the user's own Anthropic and Deepgram API keys; reviewers can obtain free keys at console.anthropic.com and console.deepgram.com." (Or provide test keys under "Instructions". If you do, use keys with a low spend limit and revoke them after review.)

**Content rating questionnaire:** Category "Utility, Productivity, Communication, or Other". Answer No to everything; the app has unrestricted web/AI output, so if asked about user-generated or AI content, say the app relays answers from a third-party AI service.

**Target audience:** 18 and over. Not designed for children.

**News app:** No.

**COVID-19 contact tracing:** No.

**Data safety:**
- Does your app collect or share user data? Yes.
- Encrypted in transit: Yes. Users can request deletion: No account exists; data is not retained by the developer (choose "not collected by developer" where offered; otherwise explain ephemeral processing).
- Data types:
  - Audio > Voice or sound recordings: collected, shared (with Deepgram), ephemeral processing, required, purpose: app functionality.
  - Personal info > Other info (user's questions as text): collected, shared (with Anthropic), ephemeral, required, purpose: app functionality.
- No data is used for advertising or analytics.

**Government apps:** No.

**Financial features:** None.

**Health:** None.

### Accessibility service declaration (required, because the app declares an AccessibilityService that is not an accessibility tool)

- **Why the app uses the API:** Voice Claude registers as the phone's digital assistant. When the user picks the optional "Claude app" mode, the earbud long press opens the official Claude app, and the accessibility service taps "New session" and "Voice Mode" so the user can start speaking without taking the phone out of their pocket, then locks the screen again. It is a deterministic, rule-based automation of two taps, armed for 20 seconds after an earbud press, and it acts only inside the Claude app (package com.anthropic.claude).
- **Does it collect or share personal/sensitive data via the API?** No. It reads accessibility labels only to locate the two buttons, and nothing is stored or transmitted.
- **In-app disclosure (done):** The main screen shows a disclosure card whenever the service is off, before the user can enable it. Tapping its single button records consent and then either switches Walk mode on (if the adb grant is present) or opens Android's Accessibility settings. The Quick Settings tile and the app-icon shortcuts refuse to enable the service until that consent has been given; they open the app to the card instead. Navigating away is not consent and the card never auto-dismisses. There is no Decline button because the card is the resting state of the screen, not a modal; add one if the reviewer insists. The card reads:

  > **Voice Claude uses the Accessibility service**
  > When you press the voice button on your Bluetooth headset, Voice Claude opens the Claude app and taps "New session" and "Voice Mode" for you, so a voice chat starts without touching the phone. The screen locks again afterwards.
  > The service only acts inside the Claude app, and only for 20 seconds after a headset press. It does not read, collect or share any screen content or personal data.
  > [Agree and turn on Walk mode] / [Agree and open settings]

- **Video:** see Status.

### Foreground service permissions declaration (FOREGROUND_SERVICE_MICROPHONE)

- **Task:** Recording the user's voice during a conversation while the screen is off or the app is in the background.
- **Why a foreground service:** The conversation is started from an earbud button with the phone in a pocket; audio capture must continue with the screen off, and Android requires a microphone foreground service for that.
- **Video:** see Status.

### Other permissions

- `BLUETOOTH_CONNECT`: route the microphone to the earbuds over Bluetooth SCO.
- `POST_NOTIFICATIONS`: ongoing-conversation notification required by the foreground service.
- `WRITE_SECURE_SETTINGS`: signature-level, never granted by Play; only used after a manual `adb pm grant` on a developer's device. Decision: keep it in the manifest. Play does not reject apps for declaring it (it is simply never granted), and removing it would break the walk-mode toggle described in the README, because `pm grant` only works for permissions the manifest declares. If a review flags it, drop the `uses-permission` line from `modules/voice-assistant/android/src/main/AndroidManifest.xml` and the toggle falls back to opening Accessibility settings.

## Release notes (first internal build)

First release. Hands-free Claude via the earbud assistant button, with walk mode toggle.

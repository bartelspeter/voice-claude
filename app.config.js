// APP_VARIANT=development builds the dev client under its own package so it
// can sit next to the Play build on the same phone (see README).
const IS_DEV = process.env.APP_VARIANT === 'development';

export default {
  expo: {
    "name": IS_DEV ? "Voice Claude (Dev)" : "Voice Claude",
    "slug": "voice-claude",
    "version": "1.0.0",
    "scheme": "voiceclaude",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "dark",
    "ios": {
      "supportsTablet": true
    },
    "android": {
      "adaptiveIcon": {
        "backgroundColor": "#F4F6FA",
        "foregroundImage": "./assets/android-icon-foreground.png",
        "monochromeImage": "./assets/android-icon-monochrome.png"
      },
      "predictiveBackGestureEnabled": false,
      "package": IS_DEV ? "com.bartelspeter.voiceclaude.dev" : "com.bartelspeter.voiceclaude"
    },
    "web": {
      "favicon": "./assets/favicon.png"
    },
    "plugins": [
      [
        "expo-audio",
        {
          "microphonePermission": "Voice Claude listens to you when you talk to it."
        }
      ],
      "expo-secure-store",
      [
        "expo-build-properties",
        {
          "android": {
            "minSdkVersion": 28
          }
        }
      ],
      [
        "expo-splash-screen",
        {
          "image": "./assets/splash-icon.png",
          "imageWidth": 160,
          "resizeMode": "contain",
          "backgroundColor": "#F4F6FA"
        }
      ]
    ],
    "owner": "peterlarsson7",
    "extra": {
      "eas": {
        "projectId": "32a13bb4-d474-4910-9ed5-50f4edf3e16a"
      }
    }
  },
};

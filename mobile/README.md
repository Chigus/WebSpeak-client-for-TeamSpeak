# Android preview

The Android app packages the existing Vue client with a small local gateway. Capacitor starts the embedded Node.js runtime, the gateway listens on `127.0.0.1:3040`, and the WebView opens that local address. The gateway is loopback-only; it does not expose an HTTP listener to the LAN.

## Build on Windows

Use the server development Node.js version (22.5 or newer) on the build host. Install all three dependency sets, then prepare and sync the Android project:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare:sdk
npm rebuild @discordjs/opus --foreground-scripts --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm --prefix mobile ci --no-audit --no-fund
npm run android:sync
```

Build the debug APKs with Android Studio's JDK and the checked-in Gradle wrapper:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
Set-Location web\android
.\gradlew.bat assembleDebug
```

Gradle writes one APK per supported CPU architecture under `web/android/app/build/outputs/apk/debug/`. Use `app-arm64-v8a-debug.apk` for most Android phones and `app-x86_64-debug.apk` for the Android emulator.

## Current scope

- Platform startup is isolated in `web/src/platform/`. Ordinary browser sessions mount directly; the native shell loads the Node.js plugin only while waiting for its loopback gateway. Startup errors, timeouts and page exit release polling and message listeners. Retry repeats the readiness handshake without restarting the embedded Node.js runtime.
- The local gateway serves the join page, public configuration, skin package, join-ticket endpoint, and voice WebSocket bridge.
- The admin console and server-side skin management are not available in this preview.
- Mobile audio encoding uses the JavaScript/WASM Opus codec. The normal server build continues to use the native Opus codec.
- The embedded runtime supplied by the current Capacitor Node.js plugin is Node.js 18.20.4. The selected gateway, identity parsing, and Opus encode/decode paths have been smoke-checked on that runtime. The TeamSpeak SDK declares Node.js 20.19 or newer, so a real connection to a TeamSpeak server still needs device testing before this is treated as a release build.
- Android WebView on the tested emulator does not expose `getDisplayMedia`; screen sharing needs a native MediaProjection integration. A persistent Android foreground service and real-device background audio behavior also remain to be implemented and verified.

## Recorded validation

On October 1, 2026, the platform startup tests passed as part of 118 application tests. Backend compilation, frontend type checking, Vite production build, asset packaging, Capacitor sync and `assembleDebug` passed. Gradle produced arm64-v8a, armeabi-v7a and x86_64 debug APKs.

The x86_64 APK installed and cold-started in a read-only Android 15 emulator. The embedded gateway returned `webspeak-android` from `/health` and `mobile: true` from `/api/public-config`; a screenshot confirmed that the WebView reached the join homepage. The narrow header was subsequently corrected and checked in desktop responsive viewports; an APK rebuild and Android layout check for that change remain pending. This checks startup and rendering only; real TeamSpeak connectivity, two-way audio and physical-device behavior remain unverified.

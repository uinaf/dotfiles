# Mobile and TV Development

Manual setup for Apple and Android app development on a workstation Mac. The
shared toolchain supports mobile apps; the additional steps below cover React
Native TV targets that need both Apple TV and Android TV simulators.

What the dotfiles already install:

- Xcode tooling, Watchman, and a Temurin 21 JDK via mise. Android Studio
  installs on `personal-workstation` only; other developer profiles get
  Homebrew's `android-commandlinetools`.
- The Android Studio SDK at `~/Library/Android/sdk` where Android Studio is
  installed, falling back to Homebrew's command-line-tools SDK elsewhere.
- That SDK's platform tools, emulator, and command line tools on `PATH`.

CocoaPods and Fastlane remain project-owned so their versions match the target
repository. Everything below is per-machine state the repo does not automate,
because the steps require sudo, GUI flows, large SDK downloads, or license
acceptance.

## Xcode and tvOS Simulator

1. Open Xcode once after install. Accept any prompts to install additional
   components.
2. Point command-line tools at the full Xcode install:

   ```zsh
   sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```

   If `xcodes` installed a versioned app, use that app's `Contents/Developer`
   directory instead.

3. Download the tvOS simulator runtime. This is multi-GB and runs in the
   background:

   ```zsh
   xcodebuild -downloadPlatform tvOS
   ```

4. Verify a tvOS simulator device type appears:

   ```zsh
   xcrun simctl list devicetypes | grep "Apple TV"
   ```

## Android Studio and Android TV

1. Launch Android Studio once (install it first on profiles other than
   `personal-workstation`). Run the first-time setup wizard with default
   settings. This installs the Android SDK under `~/Library/Android/sdk`.
2. Open a new shell and confirm the managed SDK location:

   ```zsh
   print -r -- "$ANDROID_HOME"
   command -v adb emulator sdkmanager
   ```

   `ANDROID_SDK_ROOT` is intentionally unset because Android has deprecated it.
   A project may override `ANDROID_HOME` from its own environment when it owns
   a different SDK contract.

3. Accept SDK licenses:

   ```zsh
   "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
   ```

4. Install the Android TV system image and create an AVD. Pick the API level
   the target app expects:

   ```zsh
   "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
     "system-images;android-34;android-tv;arm64-v8a"
   ```

   Create the AVD through Android Studio's Device Manager (Tools -> Device
   Manager -> Create Device -> TV) so it picks up the correct hardware
   profile.

5. Confirm `adb` and `emulator` are on PATH:

   ```zsh
   adb --version
   emulator -list-avds
   ```

### Java for Android Gradle Plugin

Android Gradle Plugin versions below 8.5 (used by React Native 0.73 and
earlier) cannot build with JDK 21. Their `jlink` invocation passes
`--disable-plugin system-modules`, which was removed in JDK 20+. Symptom:

```
Failed to transform core-for-system-modules.jar … Error while executing
process … jlink with arguments … --disable-plugin system-modules
```

Install Temurin 17 alongside the shared 21 and point gradle at it for those
projects:

```zsh
mise install java@temurin-17
export JAVA_HOME="$(mise where java@temurin-17)"
```

The `mise where` form resolves to whichever patch release mise installed,
so the export stays correct as Temurin 17.x advances. Pin the JDK at the
project level with a `mise.toml` so the repo selects 17 automatically. Do
not change the shared global mise config.

## Ruby, CocoaPods, and Fastlane

Do not `brew install cocoapods` or `gem install cocoapods` globally. React
Native repos vendor a `Gemfile` that pins CocoaPods and Fastlane; a global
install fights the pinned version. Install per repo through Bundler:

```zsh
cd path/to/app
bundle install
cd ios
bundle exec pod install
```

- Developer profiles provide modern Ruby through mise.
- A repository with a different Ruby requirement must pin that version in its own
  `mise.toml` or `.ruby-version`, and invoke Bundler or Fastlane through that
  project environment.
- Do not install Homebrew Ruby, CocoaPods, or Fastlane globally.

## Watchman

The shared install adds `watchman` via Homebrew. Confirm:

```zsh
watchman --version
```

If Watchman starts behaving oddly after macOS upgrades:

```zsh
watchman watch-del-all
brew reinstall watchman
```

## Verify

Verify the shared tools here, then run the target application's own build and
test commands:

```zsh
xcrun simctl list devicetypes | grep "Apple TV"
adb --version
watchman --version
```

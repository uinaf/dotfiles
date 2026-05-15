# React Native

Manual setup for building React Native apps on a personal Mac. Covers
react-native-tvos targets that need both Apple TV and Android TV simulators.

The dotfiles install Android Studio, Xcode tooling, Watchman, and a Temurin 21
JDK via mise. CocoaPods is installed per repo through Bundler so version pins
match the app's `Gemfile`. Everything below is per-machine state that the repo
does not automate, because the steps require sudo, GUI flows, large SDK
downloads, or license acceptance.

## Xcode and tvOS Simulator

1. Open Xcode once after install. Accept any prompts to install additional
   components.
2. Point command-line tools at the full Xcode install:

   ```zsh
   sudo xcode-select -s /Applications/Xcode-26.4.1.app
   sudo xcodebuild -license accept
   ```

   The exact `Xcode-*.app` name depends on the version installed by `xcodes`.

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

1. Launch Android Studio once. Run the first-time setup wizard with default
   settings. This installs the Android SDK under `~/Library/Android/sdk`.
2. Export the SDK location for shells that build Android apps. Add to
   `~/.zshrc` or a project `.envrc`:

   ```zsh
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   path+=("$ANDROID_HOME/platform-tools" "$ANDROID_HOME/emulator")
   ```

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

System Ruby (macOS 14+) is 2.6 and is too old for CocoaPods 1.16 and
ActiveSupport 7. Install a modern Ruby:

```zsh
brew install ruby
export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
```

Or pin via mise at the project level if the repo has a `mise.toml`. Do not
add Ruby to the shared global mise config; it does not apply to every uinaf
machine.

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

## Verifying

There is no live `verify/bootstrap.sh` check for this stack because the
required components are per-project and most users do not build native
mobile apps. If you do, sanity check with:

```zsh
xcrun simctl list devicetypes | grep "Apple TV"
adb --version
watchman --version
```

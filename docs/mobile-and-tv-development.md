# Mobile and TV Development

- [Bootstrap](bootstrap.md): Xcode utilities, Watchman, Android command-line tools;
  Android Studio on workstation profiles.
- Full Xcode follows the [declared release pin](../chezmoi/.chezmoidata/xcode.json).
  Simulator runtimes, SDK packages, and first-run GUI setup stay manual.
- Android Studio follows the [declared cask pin](../chezmoi/.chezmoidata/android-studio.json).
  SDK packages and first-run GUI setup stay manual.
- Shared mise provides Java and Ruby; projects can override those versions.
- Keep CocoaPods and Fastlane in the application's `Gemfile`.

## Xcode and tvOS Simulator

Install and select the pinned release as the Homebrew prefix owner. This is
on-demand: the six-hour updater does not download Xcode.

```zsh
mise run xcode:install
mise run xcode:check
xcodebuild -downloadPlatform tvOS
xcrun simctl list devicetypes | rg 'Apple TV'
```

`xcode:install` uses `xcodes` and installs only the numbered stable release in
the pin. Betas and Release Candidates do not count. `xcodes` needs an Apple
Developer login in that terminal (including 2FA) for the download. Simulator
runtimes are a multi-GB download. Run the application's build after
installation to verify its selected Xcode/runtime combination.

## Android Studio

Install the pinned stable cask as the Homebrew prefix owner on a workstation
profile. This is on-demand: the six-hour updater does not install Android
Studio, and Topgrade leaves its self-updater alone.

```zsh
mise run android-studio:install
mise run android-studio:check
```

`android-studio:install` uses Homebrew's `android-studio` cask and installs
only the numbered stable release in the pin. Preview, beta, canary, and RC
casks do not count. If brew's current cask is ahead of the pin, bump the pin
first. Live bootstrap verification checks this release on workstation
profiles. Headless devbox profiles skip it.

## Android TV

Run Android Studio's setup wizard if using it, then open a new shell:

```zsh
print -r -- "$ANDROID_HOME"
command -v adb emulator sdkmanager
sdkmanager --licenses
```

The shell prefers `~/Library/Android/sdk` when present, otherwise
`/opt/homebrew/share/android-commandlinetools`. Install packages for the app's
API level and host architecture; for example, an ARM64 Android TV image:

```zsh
sdkmanager 'system-images;android-34;android-tv;arm64-v8a'
```

Create a TV device in Android Studio's Device Manager, then verify:

```zsh
adb --version
emulator -list-avds
```

For a project that requires JDK 17, install and select it in the project
instead of changing the shared toolchain:

```zsh
mise install java@temurin-17
export JAVA_HOME="$(mise where java@temurin-17)"
```

## CocoaPods and Fastlane

Use the application's Ruby environment and `Gemfile`:

```zsh
cd path/to/app
bundle install
cd ios
bundle exec pod install
```

## Tizen

Keep certificates, profiles, archives, and device keys out of Git.

| Operation | Helper |
| --- | --- |
| Install and verify CLI tools | `./scripts/tizen/install.ts` |
| Archive certificates (`--full` includes SDK state) | `./scripts/tizen/pack.ts` |
| Restore an archive | `./scripts/tizen/restore.ts /path/to/archive.tar.gz` |
| Restore a recovery attachment | `./scripts/tizen/restore-from-1password.ts` |

- The 1Password helper requires `TIZEN_1PASSWORD_REFERENCE` from the operator.
- Installation verifies `tizen`, `sdb`, and package-manager info.
- Use `--show-pkgs` only when needed: Samsung's catalog download can hang.

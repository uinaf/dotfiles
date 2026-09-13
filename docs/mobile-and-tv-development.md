# Mobile and TV Development

Start with [bootstrap](bootstrap.md). The [Homebrew manifests](../homebrew/)
and [mise templates](../chezmoi/.chezmoitemplates/) own the shared toolchain;
projects can override runtime versions.

Simulator runtimes, Android SDK packages, emulator images, and first-run GUI
setup stay manual. Keep CocoaPods and Fastlane in the application’s `Gemfile`.

## Xcode and tvOS Simulator

Install and select the [pinned release](../chezmoi/.chezmoidata/xcode.json) as
the Homebrew prefix owner. Xcode downloads are on demand; the scheduled
updater does not download Xcode.

```zsh
mise run xcode:install
mise run xcode:check
xcodebuild -downloadPlatform tvOS
xcrun simctl list devicetypes | rg 'Apple TV'
```

`xcodes` needs an Apple Developer login in that terminal, including 2FA,
for the download. Simulator runtimes are a multi-GB download. Run the
application’s build afterward to verify its Xcode/runtime combination.

## Android TV

On Linux, install the Android SDK under `~/Android/Sdk` before continuing.
Accept licenses, then choose packages for the app’s API level and host
architecture. This example creates an ARM64 Android TV emulator:

```zsh
print -r -- "$ANDROID_HOME"
command -v adb emulator sdkmanager avdmanager
sdkmanager --licenses
sdkmanager 'system-images;android-34;android-tv;arm64-v8a'
avdmanager create avd -n android-tv -k 'system-images;android-34;android-tv;arm64-v8a'
```

The [shell template](../chezmoi/dot_zshrc.tmpl) selects `ANDROID_HOME` from
the installed SDK paths. Verify:

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

| Operation                                          | Helper                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Install and verify CLI tools                       | [install.ts](../bootstrap/darwin/tizen/install.ts)                               |
| Archive certificates (`--full` includes SDK state) | [pack.ts](../bootstrap/darwin/tizen/pack.ts)                                     |
| Restore an archive                                 | [restore.ts](../bootstrap/darwin/tizen/restore.ts) `/path/to/archive.tar.gz`     |
| Restore a recovery attachment                      | [restore-from-1password.ts](../bootstrap/darwin/tizen/restore-from-1password.ts) |

- The 1Password helper requires `TIZEN_1PASSWORD_REFERENCE` from the operator.
- Use `--show-pkgs` only when needed: Samsung's catalog download can hang.

# Mobile and TV Development

- [Bootstrap](bootstrap.md): Xcode utilities, Watchman, Android command-line tools;
  Android Studio on `personal-workstation`.
- Manual setup: full Xcode, simulator runtimes, SDK packages, licenses.
- Shared mise provides Java and Ruby; projects can override those versions.
- Keep CocoaPods and Fastlane in the application's `Gemfile`.

## Xcode and tvOS Simulator

Install full Xcode with `xcodes` or the App Store, then open it to finish setup.
Select its developer directory (adjust for a versioned app name):

```zsh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -downloadPlatform tvOS
xcrun simctl list devicetypes | rg 'Apple TV'
```

The simulator runtime is a multi-GB download. Run the application's build after
installation to verify its selected Xcode/runtime combination.

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

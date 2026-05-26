set dotenv-load

export ANDROID_HOME := env_var_or_default("ANDROID_HOME", env_var('HOME') + "/Android/Sdk")
export NDK_HOME := env_var('HOME') + "/Android/Sdk/ndk/29.0.13846066"
export PATH := env_var('HOME') + "/Android/Sdk/cmdline-tools/latest/bin:" + env_var('HOME') + "/Android/Sdk/platform-tools:" + env_var('PATH')

# List all recipes
default:
    @just --list

# Start desktop dev server with hot reload
dev:
    npm run tauri dev

# Start Android dev server with hot reload (requires connected device or emulator)
dev-android:
    npm run tauri android dev

# Install the app locally (builds release and installs the .deb)
install:
    npm run tauri build
    sudo dpkg -i src-tauri/target/release/bundle/deb/todoto_*.deb

# Build AppImage
appimage:
    npm run tauri build --bundles appimage
    @echo "AppImage: src-tauri/target/release/bundle/appimage/todoto_*.AppImage"

# Build Android debug APK (auto-signed, installable directly)
apk:
    npm run tauri android build -- --debug
    @echo "APK: src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"

# Build Android release APK (requires signing config)
apk-release:
    npm run tauri android build -- --apk
    @echo "APK: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"

# Generate icons from source image
icons src="img/logo/todoto.png":
    npm run tauri icon {{ src }}

# Type-check the frontend
check:
    npm run check

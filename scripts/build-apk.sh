#!/bin/sh
# Builds the signed Android APK in Docker, so no local Java or Android SDK is needed (same approach as home_builder).
# android/release.jks signs every update: lose it and the app can only be reinstalled from scratch.
set -eu
cd "$(dirname "$0")/.."
touch .env
grep -q '^KEYSTORE_PASSWORD=' .env || echo "KEYSTORE_PASSWORD=$(openssl rand -hex 16)" >> .env
KEYSTORE_PASSWORD=$(grep '^KEYSTORE_PASSWORD=' .env | cut -d= -f2)
node scripts/vendor.mjs
npx cap sync android
docker run --rm -v "$PWD:/app" -v tmuxlab-gradle:/root/.gradle -e KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" -w /app/android ghcr.io/cirruslabs/android-sdk:35 sh -c '
  [ -f release.jks ] || keytool -genkeypair -keystore release.jks -alias tmuxlab -keyalg RSA -keysize 4096 -validity 36500 \
    -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" -dname "CN=tmuxlab"
  yes | sdkmanager --licenses >/dev/null 2>&1 || true
  ./gradlew --no-daemon assembleRelease
  chown -R '"$(id -u):$(id -g)"' /app/android'
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk dist/tmuxlab.apk
node -p "require('./package.json').version" > dist/tmuxlab.version # phones on an older version offer this APK
ls -l dist/tmuxlab.apk

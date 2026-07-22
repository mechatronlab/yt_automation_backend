#!/usr/bin/env bash
# Upload .env values to Firebase Functions secrets (run once before first deploy).
# Usage: ./scripts/set-firebase-secrets.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at $ENV_FILE"
  exit 1
fi

get_env() {
  local key="$1"
  local val
  val=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
  echo "$val"
}

set_secret() {
  local key="$1"
  local val="$2"
  if [[ -z "$val" ]]; then
    echo "Skip $key (empty)"
    return
  fi
  echo "Setting secret: $key"
  printf '%s' "$val" | firebase functions:secrets:set "$key" --force
}

set_secret FIREBASE_PROJECT_ID "$(get_env FIREBASE_PROJECT_ID)"
set_secret FIREBASE_STORAGE_BUCKET "$(get_env FIREBASE_STORAGE_BUCKET)"
SA_PATH="$(get_env FIREBASE_SERVICE_ACCOUNT_PATH)"
if [[ -n "$SA_PATH" && -f "$ROOT/$SA_PATH" ]]; then
  set_secret FIREBASE_SERVICE_ACCOUNT_JSON "$(cat "$ROOT/$SA_PATH")"
elif [[ -f "$ROOT/firebase-service-account.json" ]]; then
  set_secret FIREBASE_SERVICE_ACCOUNT_JSON "$(cat "$ROOT/firebase-service-account.json")"
fi
set_secret JWT_SECRET "$(get_env JWT_SECRET)"
set_secret GOOGLE_CLIENT_ID "$(get_env GOOGLE_CLIENT_ID)"
set_secret GOOGLE_CLIENT_SECRET "$(get_env GOOGLE_CLIENT_SECRET)"
set_secret ENCRYPTION_KEY "$(get_env ENCRYPTION_KEY)"
set_secret GEMINI_API_KEY "$(get_env GEMINI_API_KEY)"
set_secret YOUTUBE_API_KEY "$(get_env YOUTUBE_API_KEY)"
set_secret FIVESIM_API_KEY "$(get_env FIVESIM_API_KEY)"
set_secret PUBLIC_BASE_URL "https://ytautomation-2fae5.web.app"

echo "Done. Enable Firestore + Storage in Firebase Console for project ytautomation-2fae5."

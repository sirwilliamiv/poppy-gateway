#!/usr/bin/env bash
# Builds the hosted Poppy agent for linux/amd64, pushes to Artifact Registry, deploys to Cloud Run.
# Usage: hosted/deploy.sh   (PROJECT_ID, REGION, SERVICE and every env var below overridable via env)
# Secrets, created once:
#   gcloud secrets create poppy-agent-signing-key --data-file=<ES256 private JWK as JSON>
#   gcloud secrets create poppy-agent-resend-key --data-file=<file holding the Resend API key>
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ID="${PROJECT_ID:-cast-commerce-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-poppy-agent}"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
TAG=$(git rev-parse --short HEAD)
IMG="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$SERVICE:$TAG"

POPPY_ISSUER="${POPPY_ISSUER:-https://poppy-agent-951611905723.us-central1.run.app}"
POPPY_PUBLIC_DOMAIN="${POPPY_PUBLIC_DOMAIN:-origin-platform-labs.netlify.app}"
GEMINI_LOCATION="${GEMINI_LOCATION:-global}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.6-flash}"
LEAD_TO="${LEAD_TO:-billy@proedu.me}"
LEAD_FROM="${LEAD_FROM:-poppy@origin-platform-labs.netlify.app}"

# Secrets are mounted by Cloud Run from Secret Manager (never passed as plain env values). Each one is
# attached only when it exists, so the service can start without them (generated key, logging lead sink).
SET_SECRETS=""
attach_secret() {
  local var="$1" name="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    SET_SECRETS="${SET_SECRETS:+$SET_SECRETS,}$var=$name:latest"
  else
    echo "warning: secret $name not found; $var will be unset" >&2
  fi
}
attach_secret POPPY_SIGNING_KEY_JWK poppy-agent-signing-key
attach_secret RESEND_API_KEY poppy-agent-resend-key
RUNTIME_SA=$(gcloud iam service-accounts list --filter="email~^$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')-compute@" --format 'value(email)')
for name in poppy-agent-signing-key poppy-agent-resend-key; do
  gcloud secrets describe "$name" >/dev/null 2>&1 && gcloud secrets add-iam-policy-binding "$name" --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null
done

gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null
docker buildx build --platform linux/amd64 -f hosted/Dockerfile -t "$IMG" --push .
gcloud run deploy "$SERVICE" \
  --image "$IMG" \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 512Mi --cpu 1 --min-instances 1 --max-instances 2 --concurrency 80 --cpu-throttling --timeout 60 \
  --set-env-vars "^|^NODE_ENV=production|POPPY_ISSUER=$POPPY_ISSUER|POPPY_PUBLIC_DOMAIN=$POPPY_PUBLIC_DOMAIN|GOOGLE_CLOUD_PROJECT=$PROJECT_ID|GEMINI_LOCATION=$GEMINI_LOCATION|GEMINI_MODEL=$GEMINI_MODEL|LEAD_TO=$LEAD_TO|LEAD_FROM=$LEAD_FROM" \
  ${SET_SECRETS:+--set-secrets "$SET_SECRETS"} \
  --quiet
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
echo "deployed: $URL"
curl -fsS "$URL/readyz" && echo
curl -fsS "$URL/.well-known/oauth-authorization-server" >/dev/null && echo "oauth metadata ok"

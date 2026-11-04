#!/usr/bin/env bash
set -euo pipefail

PVC_MANIFEST="$(dirname "$0")/grafana/grafana-pvc.yaml"

# Storage class for Grafana's PVC. A PVC's storage class can't change after creation, so reuse
# the existing one; otherwise use the cluster's default ("hostpath" on Docker Desktop, "standard"
# on kind). Override with GRAFANA_STORAGE_CLASS=<name>.
if kubectl get pvc grafana >/dev/null 2>&1; then
  STORAGE_CLASS="$(kubectl get pvc grafana -o jsonpath='{.spec.storageClassName}')"
else
  DEFAULT_CLASSES="$(kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  STORAGE_CLASS="${GRAFANA_STORAGE_CLASS:-${DEFAULT_CLASSES%%$'\n'*}}"
  STORAGE_CLASS="${STORAGE_CLASS:-hostpath}"
  echo "💾 Creating Grafana PVC with storage class '$STORAGE_CLASS'..."
  sed "s/storageClassName: hostpath/storageClassName: ${STORAGE_CLASS}/" "$PVC_MANIFEST" | kubectl apply -f - >/dev/null
fi

# Fast path: if Grafana is already up, don’t touch Helm repos (avoids slow timeouts)
if kubectl get deployment grafana >/dev/null 2>&1; then
  AVAILABLE="$(kubectl get deployment grafana -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || true)"
  if [[ "$AVAILABLE" == "True" ]]; then
    echo "✅ Grafana deployment is available. Skipping installation."
    exit 0
  fi
fi

echo "🚀 Installing Grafana using Helm..."

# Step 1: Check if Helm is installed
HELM_DIR="${HELM_DIR:-$HOME/.local/bin}"
export PATH="$HELM_DIR:$PATH"

if ! command -v helm &> /dev/null; then
  echo "⚠️ Helm not found! Installing Helm locally..."

  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      HELM_VERSION="$(curl -fsSL https://api.github.com/repos/helm/helm/releases/latest |
        sed -n 's/.*"tag_name": "\([^"]*\)".*/\1/p' |
        head -n 1)"
      ARCHIVE="$(mktemp --suffix=.zip)"
      TEMP_DIR="$(mktemp -d)"

      mkdir -p "$HELM_DIR"
      curl -fsSL -o "$ARCHIVE" "https://get.helm.sh/helm-${HELM_VERSION}-windows-amd64.zip"
      powershell.exe -NoProfile -Command \
        "Expand-Archive -LiteralPath '$(cygpath -w "$ARCHIVE")' -DestinationPath '$(cygpath -w "$TEMP_DIR")' -Force"
      cp "$TEMP_DIR/windows-amd64/helm.exe" "$HELM_DIR/helm.exe"
      rm -rf "$ARCHIVE" "$TEMP_DIR"
      export PATH="$HELM_DIR:$PATH"
      ;;
    *)
      mkdir -p "$HELM_DIR"
      # USE_SUDO=false: ~/.local/bin is user-owned, so no sudo/password prompt is needed.
      HELM_INSTALL_DIR="$HELM_DIR" USE_SUDO=false \
        bash -c "$(curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3)"
      export PATH="$HELM_DIR:$PATH"
      ;;
  esac
else
  echo "✅ Helm is already installed."
fi

# Step 2: Add Grafana Helm repository (don’t fail if network is flaky)
echo "🔄 Adding Grafana Helm repository..."
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true

# Keep this short to avoid hanging startup on Windows networks/VPNs
if ! helm repo update --timeout 30s; then
  echo "⚠️ Helm repo update timed out; continuing."
fi

# Step 3: Install/upgrade Grafana with persistence
echo "📦 Installing/Upgrading Grafana with persistent storage..."
helm upgrade --install grafana grafana/grafana \
  --set service.type=NodePort \
  --set service.nodePort=30001 \
  --set persistence.enabled=true \
  --set persistence.size=2Gi \
  --set persistence.storageClassName="$STORAGE_CLASS" \
  --set adminPassword='admin' \
  --set initChownData.enabled=false

echo "⏳ Waiting for Grafana to be ready..."
# Generous timeout: on a fresh kind cluster the Grafana image has to be pulled first.
kubectl wait --for=condition=available deployment/grafana --timeout=300s

echo "✅ Grafana is ready at: http://localhost:30001"
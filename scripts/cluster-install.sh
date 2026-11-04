#!/usr/bin/env bash
# Make sure kubectl can reach a Kubernetes cluster.
# - If the current kubectl context works (e.g. Docker Desktop with Kubernetes enabled), it is used as-is.
# - Otherwise a local kind cluster is created (or restarted), with the project's NodePorts
#   published on localhost - see scripts/kind/kind-config.yaml.
set -euo pipefail

KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-microservices-scaling}"
KIND_CONFIG="$(dirname "$0")/kind/kind-config.yaml"

cluster_reachable() {
  kubectl cluster-info --request-timeout=5s &> /dev/null
}

# kind publishes NodePorts on localhost only when the cluster is created, so a cluster made with an
# older kind-config.yaml lacks the ports added since then. Warn instead of silently missing them.
warn_missing_kind_ports() {
  local node="${KIND_CLUSTER_NAME}-control-plane" missing="" port
  for port in $(sed -n 's/.*containerPort: *\([0-9]*\).*/\1/p' "$KIND_CONFIG"); do
    docker port "$node" "$port/tcp" &> /dev/null || missing="$missing $port"
  done
  if [ -n "$missing" ]; then
    echo "⚠️  The kind cluster '$KIND_CLUSTER_NAME' was created before these ports were added to"
    echo "   scripts/kind/kind-config.yaml, so they are NOT reachable on localhost:$missing"
    echo "   Recreate the cluster to publish them: make cluster-delete && make up"
  fi
}

if cluster_reachable; then
  echo "✅ Kubernetes cluster is reachable (context: $(kubectl config current-context)). Skipping cluster setup."
  if [ "$(kubectl config current-context)" = "kind-$KIND_CLUSTER_NAME" ]; then
    warn_missing_kind_ports
  fi
  exit 0
fi

if ! command -v kind &> /dev/null; then
  echo "❌ No reachable Kubernetes cluster, and kind is not installed."
  echo "   Either enable Kubernetes in Docker Desktop, or install kind: https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
  exit 1
fi

if kind get clusters 2> /dev/null | grep -qx "$KIND_CLUSTER_NAME"; then
  echo "🔄 kind cluster '$KIND_CLUSTER_NAME' exists. Starting it and selecting its context..."
  docker start "${KIND_CLUSTER_NAME}-control-plane" > /dev/null
  kind export kubeconfig --name "$KIND_CLUSTER_NAME"
  echo "⏳ Waiting for the Kubernetes API..."
  for _ in $(seq 1 60); do
    cluster_reachable && break
    sleep 2
  done
  cluster_reachable || { echo "❌ kind cluster '$KIND_CLUSTER_NAME' did not come up. Try: make cluster-delete && make cluster"; exit 1; }
  warn_missing_kind_ports
else
  echo "🚀 No reachable cluster found. Creating kind cluster '$KIND_CLUSTER_NAME'..."
  kind create cluster --name "$KIND_CLUSTER_NAME" --config "$KIND_CONFIG" --wait 120s
fi

echo "✅ kind cluster is ready (context: kind-$KIND_CLUSTER_NAME)."

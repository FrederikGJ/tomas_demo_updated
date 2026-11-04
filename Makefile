SHELL := /bin/bash

# Makefile for managing the bank-service and Kubernetes environment

# .phony is used to declare targets that are not files, preventing conflicts with files of the same name
.PHONY: help up down skaffold bank logs k9s open cluster cluster-delete keda-install grafana-install metrics-server-install clean-bank install-dependencies

# Name of the local kind cluster that 'make cluster' creates when no other cluster is reachable
export KIND_CLUSTER_NAME ?= microservices-scaling

up: bank skaffold ## Start bank-service and Kubernetes environment

install-dependencies: ## Install all dependencies (cluster check, KEDA, Grafana, metrics-server)
	$(MAKE) cluster
	$(MAKE) keda-install
	$(MAKE) grafana-install
	$(MAKE) metrics-server-install

skaffold: install-dependencies ## Run skaffold live dev loop
	$(MAKE) open
	skaffold dev

bank: ## Build and start the external bank-service
	@echo "🟦 Building bank-service image..."
	docker build -t bank-service:latest ./bank

	@echo "🟥 Removing old bank-service container if it exists..."
	- docker rm -f bank-service

	@echo "🟩 Starting bank-service container..."
	docker run -d --name bank-service --network host \
		-e PORT=3002 \
		-e MESSAGE_SPEED=1000 \
		-e API_URL=http://localhost:32000/transactions \
		bank-service:latest

down: ## Stop bank-service and delete Kubernetes resources
	@echo "🟥 Removing bank-service container..."
	- docker rm -f bank-service

	@echo "🟥 Cleaning Skaffold resources (PVC 'grafana' will be preserved)..."
	skaffold delete

logs: ## Tail logs for a service (usage: make logs app=name)
	kubectl logs -l app=$(app) -f

k9s: ## Open k9s terminal UI with project skin, aliases, hotkeys and plugins
	bash ./scripts/k9s.sh

open: ## Open browser tabs for UIs
	bash ./scripts/open-chrome.sh

cluster: ## Use the current cluster, or create a local kind cluster if none is reachable
	bash ./scripts/cluster-install.sh

cluster-delete: ## Delete the local kind cluster created by make cluster
	kind delete cluster --name $(KIND_CLUSTER_NAME)

grafana-install: ## Install Grafana if not present
	bash ./scripts/grafana-install.sh

keda-install: ## Install KEDA operator if not present
	bash ./scripts/keda-install.sh

metrics-server-install: ## Install metrics-server if not present
	bash ./scripts/metrics-server-install.sh

help: ## Show this help menu
	@echo ""
	@echo "Available commands:"
	@echo "-------------------"
	@grep -E '^[a-zA-Z0-9_-]+:.*?##' Makefile | sed 's/:.*##/:  /' | column -t -s ':'
	@echo ""

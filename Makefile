.DEFAULT_GOAL := help

INFRA_ENV_FILE := $(if $(wildcard infra/.env),infra/.env,infra/.env.example)
COMPOSE := docker compose --env-file $(INFRA_ENV_FILE) -f infra/compose.yml

.PHONY: help infra-up infra-down model-pull web pipeline db-push test lint smoke

help:
	@printf '%s\n' \
	  'infra-up    Start Postgres and llama-server' \
	  'infra-down  Stop Postgres and llama-server' \
	  'model-pull  Download the inference model (M0-08)' \
	  'web         Run the web development server (M0-02)' \
	  'pipeline    Run the Go pipeline (M0-03)' \
	  'db-push     Apply the Drizzle schema (M1-01)' \
	  'test        Run web and pipeline tests' \
	  'lint        Run web and pipeline linters' \
	  'smoke       Run the end-to-end smoke test (M1-13)'

infra-up:
	$(COMPOSE) --profile infra up -d postgres llama

infra-down:
	$(COMPOSE) --profile infra stop postgres llama

model-pull:
	bash infra/pull-model.sh

web:
	pnpm --dir apps/web dev

pipeline:
	cd services/pipeline && go run ./cmd/pipeline

db-push:
	pnpm --dir apps/web db:push

test:
	pnpm --dir apps/web test
	cd services/pipeline && go test ./...

lint:
	pnpm --dir apps/web lint
	cd services/pipeline && go vet ./... && staticcheck ./...

smoke:
	bash scripts/smoke.sh

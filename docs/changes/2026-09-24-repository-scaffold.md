# Repository scaffold

Started M0-01 with a pnpm workspace, root Make targets, standard editor and ignore rules, and a development Compose profile for Postgres and Vulkan llama-server. The Compose configuration uses `infra/.env` when present and `infra/.env.example` for local defaults.

Verification: `make help` and `docker compose config` pass. The Postgres service started, accepted connections, and stopped through `make infra-down`. The sandbox has no `/dev/dri`, so starting the Vulkan llama service remains unverified here.

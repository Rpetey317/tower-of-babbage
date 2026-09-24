# Repository scaffold

Started M0-01 with a pnpm workspace, root Make targets, standard editor and ignore rules, and a development Compose profile for Postgres and Vulkan llama-server. The Compose configuration uses `infra/.env` when present and `infra/.env.example` for local defaults.

Added automatic CPU fallback for hosts without `/dev/dri`, including Docker
Desktop on WSL2. Native Linux keeps the Vulkan service.

Verification: `make help` and `docker compose config --quiet` pass.
`make infra-up` selected `llama-cpu` on WSL2 and started both it and Postgres;
`make infra-down` stopped both, and a second `make infra-up` restarted them.
Postgres reported healthy while llama-server began its first model download.

# Pipeline scaffold (M0-03)

Added the Go pipeline entry point with validated environment settings, JSON
logging, signal-driven shutdown, and the public `/healthz` contract response.
The health response reports configured inference endpoints as unhealthy until
provider probes are implemented, and reports zero active sessions until the
session runner exists. The container image includes ffmpeg and runs as a
non-root user.

Verification: `go test ./...`, `go vet ./...`, `staticcheck ./...`, live
`PROVIDER=mock make pipeline` plus `GET /healthz` and SIGTERM, and a Docker image
build with ffmpeg version check. These checks require no GPU.

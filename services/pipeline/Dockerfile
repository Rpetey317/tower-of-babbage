FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /pipeline ./cmd/pipeline

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /pipeline /usr/local/bin/pipeline
ENV FIXTURES_DIR=/fixtures
USER 65532:65532
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/pipeline"]

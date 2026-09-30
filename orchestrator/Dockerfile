# Step 1: Build C++ engine
FROM gcc:13-bookworm AS cpp-builder
WORKDIR /cpp
COPY engine/include/ ./engine/include/
COPY engine/src/ ./engine/src/
RUN g++ -std=c++17 -O3 -static -I engine/include engine/src/main.cpp -o /cpp/faultline_engine

# Step 2: Build Go Orchestrator
FROM golang:1.23-alpine AS go-builder
WORKDIR /go/src/app
COPY orchestrator/go.mod orchestrator/go.sum* ./
COPY orchestrator/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /go/bin/faultline_orchestrator ./cmd/server

# Step 3: Minimal runtime container
FROM alpine:3.19
WORKDIR /app

RUN apk --no-cache add ca-certificates

COPY --from=cpp-builder /cpp/faultline_engine /app/engine/faultline_engine
COPY --from=go-builder /go/bin/faultline_orchestrator /app/faultline_orchestrator

ENV ENGINE_BIN=/app/engine/faultline_engine
ENV PORT=8080
ENV RUNS_DIR=/app/runs

EXPOSE 8080

ENTRYPOINT ["/app/faultline_orchestrator"]

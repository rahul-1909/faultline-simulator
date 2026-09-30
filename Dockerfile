# Multi-stage Unified Build for Faultline (All-in-One Cloud Deployment)

# Stage 1: Build C++ Simulation Engine
FROM gcc:13-bookworm AS cpp-builder
WORKDIR /cpp
COPY engine/include/ ./engine/include/
COPY engine/src/ ./engine/src/
RUN g++ -std=c++17 -O3 -static -I engine/include engine/src/main.cpp -o /cpp/faultline_engine

# Stage 2: Build React Dashboard
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install
COPY dashboard/ ./
ENV VITE_ORCHESTRATOR_URL=""
ENV VITE_ANALYTICS_URL=""
RUN npm run build

# Stage 3: Build Go Orchestrator
FROM golang:1.23-alpine AS go-builder
WORKDIR /go/src/app
COPY orchestrator/go.mod orchestrator/go.sum* ./
COPY orchestrator/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /go/bin/faultline_orchestrator ./cmd/server

# Stage 4: Unified Runtime Image
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PORT=8080
ENV ENGINE_BIN=/app/engine/faultline_engine
ENV RUNS_DIR=/app/runs
ENV STATIC_DIR=/app/dashboard/dist
ENV ANALYTICS_URL=http://127.0.0.1:8000
ENV ORCHESTRATOR_URL=http://127.0.0.1:8080

# Install Python dependencies
COPY analysis/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application artifacts
COPY analysis/app/ ./app/
COPY --from=cpp-builder /cpp/faultline_engine /app/engine/faultline_engine
COPY --from=go-builder /go/bin/faultline_orchestrator /app/faultline_orchestrator
COPY --from=frontend-builder /app/dist /app/dashboard/dist

# Entrypoint script
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/engine/faultline_engine /app/faultline_orchestrator

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]

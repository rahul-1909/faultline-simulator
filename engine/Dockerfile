# Build stage for C++ Discrete-Event Simulation Engine
FROM gcc:13-bookworm AS builder

WORKDIR /app
COPY CMakeLists.txt ./
COPY include/ ./include/
COPY src/ ./src/

RUN g++ -std=c++17 -O3 -static -I include src/main.cpp -o faultline_engine

# Output stage: minimal scratch/alpine image
FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/faultline_engine /app/faultline_engine

ENTRYPOINT ["/app/faultline_engine"]

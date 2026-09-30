#pragma once

#include <cstdint>
#include <string>
#include <memory>
#include <functional>

namespace faultline {

// Simulated time measured in microseconds (1 second = 1,000,000 us).
// Integer representation guarantees 100% deterministic, cross-platform simulation.
using SimTime = uint64_t;

// Standard conversion helpers
constexpr SimTime MS_TO_US(SimTime ms) { return ms * 1000ULL; }
constexpr SimTime SEC_TO_US(SimTime sec) { return sec * 1000000ULL; }
constexpr double US_TO_MS(SimTime us) { return static_cast<double>(us) / 1000.0; }
constexpr double US_TO_SEC(SimTime us) { return static_cast<double>(us) / 1000000.0; }

/**
 * Types of discrete events that occur in a distributed system.
 */
enum class EventType {
    REQUEST_GENERATED,    // Client initiates a request
    REQUEST_ARRIVED,      // Request reaches target node ingress queue
    PROCESS_START,        // Node begins processing request
    PROCESS_COMPLETE,     // Node finishes computation
    NETWORK_TRANSMIT,     // Packet dispatched onto network link
    NETWORK_DELIVER,      // Packet reaches other side of link
    NODE_CRASH,           // Injected failure: server crashes immediately
    NODE_RECOVER,         // Server recovers and reboots
    LINK_DEGRADE,         // Injected failure: latency spike or packet loss
    LINK_RESTORE,         // Network link returns to normal
    TIMEOUT_EXPIRED       // Client or upstream service timeout
};

/**
 * String conversion for telemetry and debugging logs
 */
inline std::string event_type_to_string(EventType type) {
    switch (type) {
        case EventType::REQUEST_GENERATED: return "REQUEST_GENERATED";
        case EventType::REQUEST_ARRIVED:   return "REQUEST_ARRIVED";
        case EventType::PROCESS_START:     return "PROCESS_START";
        case EventType::PROCESS_COMPLETE:  return "PROCESS_COMPLETE";
        case EventType::NETWORK_TRANSMIT:  return "NETWORK_TRANSMIT";
        case EventType::NETWORK_DELIVER:   return "NETWORK_DELIVER";
        case EventType::NODE_CRASH:        return "NODE_CRASH";
        case EventType::NODE_RECOVER:      return "NODE_RECOVER";
        case EventType::LINK_DEGRADE:      return "LINK_DEGRADE";
        case EventType::LINK_RESTORE:      return "LINK_RESTORE";
        case EventType::TIMEOUT_EXPIRED:   return "TIMEOUT_EXPIRED";
        default:                           return "UNKNOWN";
    }
}

/**
 * Represents a single request traveling through the distributed system.
 */
struct Request {
    uint64_t id{0};
    std::string trace_id;          // Distributed tracing identifier (like OpenTelemetry / Jaeger)
    SimTime created_at{0};         // Sim timestamp when client sent request
    SimTime completed_at{0};       // Sim timestamp when response received
    bool is_failed{false};         // Flagged true if dropped, timed out, or crashed
    std::string failure_reason;    // "TIMEOUT", "NODE_DOWN", "QUEUE_FULL", "NETWORK_LOSS"
    int retry_count{0};            // How many times this request has been retried
    uint64_t payload_bytes{256};   // Simulated payload size
};

/**
 * The fundamental unit of Discrete-Event Simulation.
 * Encapsulates when an action happens, what happens, and what function to execute.
 */
struct Event {
    uint64_t event_id{0};          // Monotonically increasing unique ID
    SimTime time{0};               // Virtual timestamp when this event executes
    EventType type{EventType::REQUEST_GENERATED};
    std::string entity_id;         // Target node ID or link ID (e.g., "payment-service-1")
    std::shared_ptr<Request> req;  // Associated request context (if applicable)
    
    // Action callback executed when the scheduler reaches this event's timestamp
    std::function<void()> action;

    Event() = default;

    Event(uint64_t id, SimTime t, EventType ty, std::string target, 
          std::shared_ptr<Request> r = nullptr, std::function<void()> act = nullptr)
        : event_id(id), time(t), type(ty), entity_id(std::move(target)), 
          req(std::move(r)), action(std::move(act)) {}
};

/**
 * Comparator for std::priority_queue (Min-Heap).
 * In C++, std::priority_queue is a Max-Heap by default.
 * Returning (a > b) makes it a Min-Heap, meaning the event with the
 * SMALLEST timestamp comes out first.
 * If timestamps are identical, the earlier scheduled event_id wins (FIFO).
 */
struct EventComparator {
    bool operator()(const Event& a, const Event& b) const {
        if (a.time != b.time) {
            return a.time > b.time; // Smallest time first
        }
        return a.event_id > b.event_id; // Tie-breaker: earlier scheduled event first
    }
};

} // namespace faultline

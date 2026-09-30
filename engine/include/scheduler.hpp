#pragma once

#include "event.hpp"
#include <queue>
#include <vector>
#include <functional>
#include <chrono>

namespace faultline {

/**
 * Observer callback for telemetry, logging, and Kafka streaming.
 * Every time an event is popped and executed, registered observers are notified.
 */
using EventObserver = std::function<void(const Event&, SimTime current_time)>;

/**
 * The Central Discrete-Event Scheduler.
 * 
 * Responsibilities:
 * 1. Maintains the Virtual Simulation Clock (current_time).
 * 2. Houses the Min-Heap Priority Queue of all scheduled events.
 * 3. Advances time strictly in event-arrival order.
 * 4. Dispatches event action callbacks and telemetry notifications.
 */
class Scheduler {
public:
    Scheduler() : current_time_(0), next_event_id_(1), total_events_processed_(0) {}

    /**
     * Schedule an event to happen after a relative delay (in microseconds) from current time.
     */
    uint64_t schedule(SimTime delay_us, EventType type, const std::string& entity_id,
                      std::shared_ptr<Request> req = nullptr,
                      std::function<void()> action = nullptr) {
        return schedule_at(current_time_ + delay_us, type, entity_id, std::move(req), std::move(action));
    }

    /**
     * Schedule an event at an exact absolute simulated timestamp (in microseconds).
     */
    uint64_t schedule_at(SimTime abs_time_us, EventType type, const std::string& entity_id,
                         std::shared_ptr<Request> req = nullptr,
                         std::function<void()> action = nullptr) {
        uint64_t id = next_event_id_++;
        events_.emplace(id, abs_time_us, type, entity_id, std::move(req), std::move(action));
        return id;
    }

    /**
     * Advance the simulation by exactly one event.
     * Returns false if there are no more events to process.
     */
    bool step() {
        if (events_.empty()) {
            return false;
        }

        // Pop the earliest scheduled event from the Min-Heap
        Event ev = std::move(const_cast<Event&>(events_.top()));
        events_.pop();

        // Advance the virtual clock directly to this event's scheduled timestamp
        current_time_ = ev.time;
        total_events_processed_++;

        // Notify telemetry listeners (e.g. logger, trace collectors)
        for (const auto& observer : observers_) {
            if (observer) {
                observer(ev, current_time_);
            }
        }

        // Execute the event's state transition logic
        if (ev.action) {
            ev.action();
        }

        return true;
    }

    /**
     * Run the simulation until virtual time reaches max_time_us or the queue empties.
     * Returns total events processed in this run.
     */
    uint64_t run_until(SimTime max_time_us) {
        auto wall_start = std::chrono::high_resolution_clock::now();

        while (!events_.empty()) {
            // Check if the next event exceeds our target simulation time horizon
            if (events_.top().time > max_time_us) {
                current_time_ = max_time_us;
                break;
            }

            step();
        }

        auto wall_end = std::chrono::high_resolution_clock::now();
        last_wall_duration_ms_ = std::chrono::duration<double, std::milli>(wall_end - wall_start).count();

        return total_events_processed_;
    }

    /**
     * Register a telemetry callback that observes all event dispatches.
     */
    void add_observer(EventObserver obs) {
        observers_.push_back(std::move(obs));
    }

    // Accessors
    SimTime current_time() const { return current_time_; }
    size_t pending_event_count() const { return events_.size(); }
    uint64_t total_events_processed() const { return total_events_processed_; }
    double last_wall_duration_ms() const { return last_wall_duration_ms_; }

    /**
     * Reset scheduler state for a clean new experiment.
     */
    void reset() {
        while (!events_.empty()) events_.pop();
        current_time_ = 0;
        next_event_id_ = 1;
        total_events_processed_ = 0;
        last_wall_duration_ms_ = 0.0;
    }

private:
    SimTime current_time_{0};
    uint64_t next_event_id_{1};
    uint64_t total_events_processed_{0};
    double last_wall_duration_ms_{0.0};

    // Min-Heap priority queue holding all pending simulation events
    std::priority_queue<Event, std::vector<Event>, EventComparator> events_;

    // Telemetry observers
    std::vector<EventObserver> observers_;
};

} // namespace faultline

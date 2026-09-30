#pragma once

#include "event.hpp"
#include "scheduler.hpp"
#include <deque>
#include <string>
#include <memory>
#include <iostream>

namespace faultline
{

    enum class NodeState
    {
        ONLINE,
        DEGRADED,
        CRASHED
    };

    inline std::string node_state_to_string(NodeState state)
    {
        switch (state)
        {
        case NodeState::ONLINE:
            return "ONLINE";
        case NodeState::DEGRADED:
            return "DEGRADED";
        case NodeState::CRASHED:
            return "CRASHED";
        default:
            return "UNKNOWN";
        }
    }

    /**
     * Statistics tracked by each simulated node
     */
    struct NodeStats
    {
        uint64_t requests_received{0};
        uint64_t requests_processed{0};
        uint64_t requests_dropped_queue_full{0};
        uint64_t requests_dropped_crashed{0};
        size_t peak_queue_depth{0};
    };

    /**
     * Represents a simulated Service/Server Node in the distributed topology.
     */
    class Node
    {
    public:
        Node(std::string id, size_t concurrency_limit = 2, size_t queue_capacity = 10, SimTime service_time_us = MS_TO_US(10))
            : id_(std::move(id)),
              concurrency_limit_(concurrency_limit),
              queue_capacity_(queue_capacity),
              base_service_time_us_(service_time_us),
              state_(NodeState::ONLINE),
              active_workers_(0) {}

        /**
         * Entry point: called when a request arrives at this node's ingress.
         */
        void receive_request(Scheduler &scheduler, std::shared_ptr<Request> req)
        {
            stats_.requests_received++;

            // 1. If server is crashed, drop immediately
            if (state_ == NodeState::CRASHED)
            {
                req->is_failed = true;
                req->failure_reason = "NODE_DOWN";
                stats_.requests_dropped_crashed++;
                return;
            }

            // 2. If workers are available, start processing right away
            if (active_workers_ < concurrency_limit_)
            {
                start_processing(scheduler, std::move(req));
                return;
            }

            // 3. Workers are busy. Check if ingress queue has space
            if (ingress_queue_.size() >= queue_capacity_)
            {
                req->is_failed = true;
                req->failure_reason = "QUEUE_FULL";
                stats_.requests_dropped_queue_full++;
                return;
            }

            // 4. Enqueue request to wait for an available worker
            ingress_queue_.push_back(std::move(req));
            if (ingress_queue_.size() > stats_.peak_queue_depth)
            {
                stats_.peak_queue_depth = ingress_queue_.size();
            }
        }

        /**
         * Chaos injection: Crash this node immediately.
         */
        void crash()
        {
            state_ = NodeState::CRASHED;
            active_workers_ = 0;
            // Purge queued requests as failed
            while (!ingress_queue_.empty())
            {
                auto req = ingress_queue_.front();
                ingress_queue_.pop_front();
                req->is_failed = true;
                req->failure_reason = "NODE_CRASHED_DURING_WAIT";
                stats_.requests_dropped_crashed++;
            }
        }

        /**
         * Chaos recovery: Reboot this node back to ONLINE.
         */
        void recover()
        {
            state_ = NodeState::ONLINE;
            active_workers_ = 0;
        }

        void degrade() { state_ = NodeState::DEGRADED; }

        // Accessors
        const std::string &id() const { return id_; }
        NodeState state() const { return state_; }
        size_t active_workers() const { return active_workers_; }
        size_t current_queue_size() const { return ingress_queue_.size(); }
        const NodeStats &stats() const { return stats_; }

    private:
        /**
         * Dispatches a worker to process the request and schedules its completion event.
         */
        void start_processing(Scheduler &scheduler, std::shared_ptr<Request> req)
        {
            active_workers_++;

            // Compute service processing latency (3x longer if degraded)
            SimTime latency = (state_ == NodeState::DEGRADED)
                                  ? base_service_time_us_ * 3
                                  : base_service_time_us_;

            // Schedule the PROCESS_COMPLETE event in the scheduler
            scheduler.schedule(latency, EventType::PROCESS_COMPLETE, id_, req, [this, &scheduler, req]()
                               { this->on_process_complete(scheduler, req); });
        }

        /**
         * Called when a worker finishes computing a request.
         */
        void on_process_complete(Scheduler &scheduler, std::shared_ptr<Request> req)
        {
            // If server crashed while processing, discard result
            if (state_ == NodeState::CRASHED)
            {
                return;
            }

            req->completed_at = scheduler.current_time();
            stats_.requests_processed++;
            active_workers_--;

            // If there are pending requests in the ingress queue, grab the next one!
            if (!ingress_queue_.empty())
            {
                auto next_req = ingress_queue_.front();
                ingress_queue_.pop_front();
                start_processing(scheduler, std::move(next_req));
            }
        }

        std::string id_;
        size_t concurrency_limit_;
        size_t queue_capacity_;
        SimTime base_service_time_us_;
        NodeState state_;
        size_t active_workers_;
        std::deque<std::shared_ptr<Request>> ingress_queue_;
        NodeStats stats_;
    };

} // namespace faultline
#pragma once

#include "event.hpp"
#include "scheduler.hpp"
#include "node.hpp"
#include <string>
#include <memory>
#include <random>

namespace faultline
{

    enum class LinkState
    {
        HEALTHY,
        DEGRADED,   // 5x latency spike
        PARTITIONED // 100% packet loss (network split)
    };

    inline std::string link_state_to_string(LinkState state)
    {
        switch (state)
        {
        case LinkState::HEALTHY:
            return "HEALTHY";
        case LinkState::DEGRADED:
            return "DEGRADED";
        case LinkState::PARTITIONED:
            return "PARTITIONED";
        default:
            return "UNKNOWN";
        }
    }

    struct LinkStats
    {
        uint64_t packets_transmitted{0};
        uint64_t packets_delivered{0};
        uint64_t packets_dropped_partition{0};
        uint64_t packets_dropped_loss{0};
    };

    /**
     * Models a unidirectional or bidirectional network link between two nodes.
     */
    class NetworkLink
    {
    public:
        NetworkLink(std::string id, std::string source_id, std::string target_id,
                    SimTime base_latency_us = MS_TO_US(10),
                    SimTime jitter_us = MS_TO_US(2),
                    double drop_rate = 0.0,
                    uint32_t seed = 42)
            : id_(std::move(id)),
              source_id_(std::move(source_id)),
              target_id_(std::move(target_id)),
              base_latency_us_(base_latency_us),
              jitter_us_(jitter_us),
              drop_rate_(drop_rate),
              state_(LinkState::HEALTHY),
              rng_(seed),
              dist_uniform_(0.0, 1.0) {}

        /**
         * Transmit a request across the link from source to target.
         */
        void transmit(Scheduler &scheduler, std::shared_ptr<Request> req,
                      std::function<void(std::shared_ptr<Request>)> on_deliver)
        {
            stats_.packets_transmitted++;

            // 1. Check for complete Network Partition (Split-Brain)
            if (state_ == LinkState::PARTITIONED)
            {
                req->state = RequestState::FAILED;
                req->is_failed = true;
                req->failure_reason = "NETWORK_PARTITION";
                stats_.packets_dropped_partition++;
                return;
            }

            // 2. Check for probabilistic packet drop
            if (drop_rate_ > 0.0 && dist_uniform_(rng_) < drop_rate_)
            {
                req->state = RequestState::FAILED;
                req->is_failed = true;
                req->failure_reason = "PACKET_LOSS";
                stats_.packets_dropped_loss++;
                return;
            }

            // 3. Compute realistic latency with jitter
            SimTime effective_base = (state_ == LinkState::DEGRADED)
                                         ? base_latency_us_ * 5
                                         : base_latency_us_;

            // Add random jitter between [-jitter_us, +jitter_us]
            int64_t jitter = 0;
            if (jitter_us_ > 0)
            {
                std::uniform_int_distribution<int64_t> jitter_dist(-static_cast<int64_t>(jitter_us_), static_cast<int64_t>(jitter_us_));
                jitter = jitter_dist(rng_);
            }

            int64_t total_latency = static_cast<int64_t>(effective_base) + jitter;
            SimTime travel_time = (total_latency > 100) ? static_cast<SimTime>(total_latency) : 100ULL; // Min 100us

            // 4. Schedule the arrival of the packet at the target node
            scheduler.schedule(travel_time, EventType::NETWORK_DELIVER, target_id_, req, [this, req, on_deliver]()
                               {
                this->stats_.packets_delivered++;
                if (on_deliver) {
                    on_deliver(req);
                } });
        }

        // Chaos controls
        void partition() { state_ = LinkState::PARTITIONED; }
        void heal() { state_ = LinkState::HEALTHY; }
        void degrade() { state_ = LinkState::DEGRADED; }
        void set_drop_rate(double rate) { drop_rate_ = rate; }

        // Accessors
        const std::string &id() const { return id_; }
        const std::string &source_id() const { return source_id_; }
        const std::string &target_id() const { return target_id_; }
        SimTime base_latency_us() const { return base_latency_us_; }
        SimTime jitter_us() const { return jitter_us_; }
        double drop_rate() const { return drop_rate_; }
        LinkState state() const { return state_; }
        const LinkStats &stats() const { return stats_; }

    private:
        std::string id_;
        std::string source_id_;
        std::string target_id_;
        SimTime base_latency_us_;
        SimTime jitter_us_;
        double drop_rate_;
        LinkState state_;

        // Deterministic random number generator (reproducible simulations!)
        std::mt19937 rng_;
        std::uniform_real_distribution<double> dist_uniform_;
        LinkStats stats_;
    };

} // namespace faultline
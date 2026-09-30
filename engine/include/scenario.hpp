#pragma once

#include "event.hpp"
#include "scheduler.hpp"
#include "node.hpp"
#include "link.hpp"
#include "nlohmann/json.hpp"
#include <fstream>
#include <iostream>
#include <unordered_map>
#include <vector>
#include <algorithm>

namespace faultline
{

    using json = nlohmann::json;

    class SimulationEngine
    {
    public:
        SimulationEngine() = default;

        bool load_scenario(const std::string &filepath)
        {
            std::ifstream file(filepath);
            if (!file.is_open())
            {
                std::cerr << "Failed to open scenario file: " << filepath << "\n";
                return false;
            }

            try
            {
                file >> scenario_json_;
            }
            catch (const std::exception &e)
            {
                std::cerr << "JSON parse error: " << e.what() << "\n";
                return false;
            }

            return setup();
        }

        bool load_scenario_from_json(json scen)
        {
            scenario_json_ = std::move(scen);
            return setup();
        }

        void run()
        {
            SimTime duration_us = MS_TO_US(scenario_json_.value("duration_ms", 1000ULL));
            scheduler_.run_until(duration_us);
        }

        const Scheduler &scheduler() const { return scheduler_; }

        void export_results(const std::string &output_filepath)
        {
            json out;
            out["scenario_name"] = scenario_json_.value("name", "Unnamed Scenario");
            out["seed"] = scenario_json_.value("seed", 42);
            out["simulated_time_ms"] = US_TO_MS(scheduler_.current_time());
            out["wall_clock_time_ms"] = scheduler_.last_wall_duration_ms();
            out["total_events_processed"] = scheduler_.total_events_processed();

            // Requests summary
            uint64_t success = 0;
            uint64_t failed = 0;
            std::unordered_map<std::string, uint64_t> failure_reasons;
            std::vector<double> latencies_ms;

            for (const auto &req : all_requests_)
            {
                if (req->state == RequestState::SUCCEEDED && req->completed_at > 0)
                {
                    success++;
                    latencies_ms.push_back(US_TO_MS(req->completed_at - req->created_at));
                }
                else
                {
                    failed++;
                    std::string reason = req->failure_reason;
                    if (reason.empty())
                    {
                        reason = (req->state == RequestState::IN_FLIGHT) ? "TIMEOUT_UNFINISHED" : "FAILED_UNKNOWN";
                    }
                    failure_reasons[reason]++;
                }
            }

            out["metrics"]["total_requests"] = all_requests_.size();
            out["metrics"]["successful_requests"] = success;
            out["metrics"]["failed_requests"] = failed;
            out["metrics"]["total_retries"] = total_retries_;
            out["metrics"]["availability_percent"] = all_requests_.empty() ? 100.0 : (static_cast<double>(success) / all_requests_.size()) * 100.0;
            out["metrics"]["failure_breakdown"] = failure_reasons;

            // Latency percentiles (documented nearest-rank calculation)
            if (!latencies_ms.empty())
            {
                std::sort(latencies_ms.begin(), latencies_ms.end());
                auto calc_p = [&](double p) -> double {
                    size_t rank = static_cast<size_t>(std::ceil(p * latencies_ms.size()));
                    if (rank == 0) rank = 1;
                    if (rank > latencies_ms.size()) rank = latencies_ms.size();
                    return latencies_ms[rank - 1];
                };
                out["metrics"]["latency_ms"]["min"] = latencies_ms.front();
                out["metrics"]["latency_ms"]["p50"] = calc_p(0.50);
                out["metrics"]["latency_ms"]["p95"] = calc_p(0.95);
                out["metrics"]["latency_ms"]["p99"] = calc_p(0.99);
                out["metrics"]["latency_ms"]["max"] = latencies_ms.back();
            }
            else
            {
                out["metrics"]["latency_ms"]["min"] = 0.0;
                out["metrics"]["latency_ms"]["p50"] = 0.0;
                out["metrics"]["latency_ms"]["p95"] = 0.0;
                out["metrics"]["latency_ms"]["p99"] = 0.0;
                out["metrics"]["latency_ms"]["max"] = 0.0;
            }

            // Per-node stats & actual simulated topology state
            for (const auto &[id, node] : nodes_)
            {
                const auto &s = node->stats();
                out["nodes"][id] = {
                    {"received", s.requests_received},
                    {"processed", s.requests_processed},
                    {"dropped_queue_full", s.requests_dropped_queue_full},
                    {"dropped_crashed", s.requests_dropped_crashed},
                    {"peak_queue_depth", s.peak_queue_depth},
                    {"active_workers", node->active_workers()},
                    {"concurrency", node->concurrency_limit()},
                    {"queue_capacity", node->queue_capacity()},
                    {"service_time_ms", US_TO_MS(node->service_time_us())},
                    {"final_state", node_state_to_string(node->state())}};
            }

            // Per-link stats & actual simulated topology state
            for (const auto &[id, link] : links_)
            {
                const auto &s = link->stats();
                out["links"][id] = {
                    {"transmitted", s.packets_transmitted},
                    {"delivered", s.packets_delivered},
                    {"dropped_partition", s.packets_dropped_partition},
                    {"dropped_loss", s.packets_dropped_loss},
                    {"source", link->source_id()},
                    {"target", link->target_id()},
                    {"latency_ms", US_TO_MS(link->base_latency_us())},
                    {"jitter_ms", US_TO_MS(link->jitter_us())},
                    {"drop_rate", link->drop_rate()},
                    {"final_state", link_state_to_string(link->state())}};
            }

            // Copy chaos timeline
            if (scenario_json_.contains("chaos"))
            {
                out["chaos_events"] = scenario_json_["chaos"];
            }
            else
            {
                out["chaos_events"] = json::array();
            }

            std::ofstream out_file(output_filepath);
            if (out_file.is_open())
            {
                out_file << out.dump(4);
                std::cout << "\nResults successfully written to: " << output_filepath << "\n";
            }
            else
            {
                std::cerr << "Failed to write results to " << output_filepath << "\n";
            }
        }

    private:
        struct RetryPolicy
        {
            int max_retries{0};
            SimTime backoff_ms{25};
            double backoff_multiplier{1.5};
            SimTime jitter_ms{5};
        };

        bool validate_scenario()
        {
            if (!scenario_json_.is_object())
            {
                std::cerr << "[Validation Error] Scenario root must be a JSON object.\n";
                return false;
            }

            // Duration check
            if (scenario_json_.value("duration_ms", 1000ULL) == 0 || scenario_json_.value("duration_ms", 1000ULL) > 3600000ULL)
            {
                std::cerr << "[Validation Error] duration_ms must be between 1 and 3,600,000 ms.\n";
                return false;
            }

            // Nodes check
            if (!scenario_json_.contains("nodes") || !scenario_json_["nodes"].is_array() || scenario_json_["nodes"].empty())
            {
                std::cerr << "[Validation Error] 'nodes' must be a non-empty array.\n";
                return false;
            }

            std::unordered_map<std::string, bool> node_ids;
            for (const auto &n : scenario_json_["nodes"])
            {
                if (!n.is_object() || !n.contains("id") || !n["id"].is_string() || n["id"].get<std::string>().empty())
                {
                    std::cerr << "[Validation Error] Every node must have a non-empty string 'id'.\n";
                    return false;
                }
                std::string id = n["id"];
                if (node_ids.count(id))
                {
                    std::cerr << "[Validation Error] Duplicate node id detected: " << id << "\n";
                    return false;
                }
                node_ids[id] = true;

                // Support both canonical 'concurrency' and legacy 'workers'
                int concurrency = n.contains("concurrency") ? n.value("concurrency", 4) : n.value("workers", 4);
                if (concurrency <= 0)
                {
                    std::cerr << "[Validation Error] Node " << id << " concurrency must be > 0.\n";
                    return false;
                }
                if (n.value("queue_capacity", 20) < 0)
                {
                    std::cerr << "[Validation Error] Node " << id << " queue_capacity cannot be negative.\n";
                    return false;
                }
                // Support both canonical 'service_time_ms' and legacy 'processing_time_ms'
                uint64_t svc_time = n.contains("service_time_ms") ? n.value("service_time_ms", 10ULL) : n.value("processing_time_ms", 10ULL);
                if (svc_time > 3600000ULL)
                {
                    std::cerr << "[Validation Error] Node " << id << " service_time_ms is invalid.\n";
                    return false;
                }
            }

            // Links check
            std::unordered_map<std::string, bool> link_ids;
            std::unordered_map<std::string, bool> connected_pairs;
            if (scenario_json_.contains("links") && scenario_json_["links"].is_array())
            {
                for (const auto &l : scenario_json_["links"])
                {
                    if (!l.contains("id") || !l.contains("source") || !l.contains("target"))
                    {
                        std::cerr << "[Validation Error] Every link must define id, source, and target.\n";
                        return false;
                    }
                    std::string lid = l["id"];
                    std::string src = l["source"];
                    std::string tgt = l["target"];
                    if (link_ids.count(lid))
                    {
                        std::cerr << "[Validation Error] Duplicate link id detected: " << lid << "\n";
                        return false;
                    }
                    link_ids[lid] = true;
                    connected_pairs[src + "->" + tgt] = true;

                    if (!node_ids.count(src))
                    {
                        std::cerr << "[Validation Error] Link " << lid << " source node '" << src << "' does not exist.\n";
                        return false;
                    }
                    if (!node_ids.count(tgt))
                    {
                        std::cerr << "[Validation Error] Link " << lid << " target node '" << tgt << "' does not exist.\n";
                        return false;
                    }
                    double drop_rate = l.value("drop_rate", 0.0);
                    if (drop_rate < 0.0 || drop_rate > 1.0)
                    {
                        std::cerr << "[Validation Error] Link " << lid << " drop_rate must be between 0.0 and 1.0.\n";
                        return false;
                    }
                }
            }

            // Workload check
            if (scenario_json_.contains("workload") && scenario_json_["workload"].is_object())
            {
                const auto &w = scenario_json_["workload"];
                // Support both canonical 'requests_per_second' and legacy 'arrival_rate_rps'
                double rps = w.contains("requests_per_second") ? w.value("requests_per_second", 50.0) : w.value("arrival_rate_rps", 50.0);
                if (rps <= 0.0 || rps > 100000.0)
                {
                    std::cerr << "[Validation Error] requests_per_second must be between 0.1 and 100,000.\n";
                    return false;
                }
                if (w.contains("route"))
                {
                    std::vector<std::string> route = w["route"];
                    if (route.empty())
                    {
                        std::cerr << "[Validation Error] Workload route cannot be empty.\n";
                        return false;
                    }
                    for (const auto &nid : route)
                    {
                        if (!node_ids.count(nid))
                        {
                            std::cerr << "[Validation Error] Workload route references non-existent node: " << nid << "\n";
                            return false;
                        }
                    }

                    // Strict topology validation: verify every adjacent route hop has a connecting link
                    for (size_t i = 0; i + 1 < route.size(); i++)
                    {
                        std::string pair = route[i] + "->" + route[i + 1];
                        if (!connected_pairs.count(pair))
                        {
                            std::cerr << "[Validation Error] No network link defined between route hop '" << route[i] << "' and '" << route[i + 1] << "'. Missing route links are not permitted.\n";
                            return false;
                        }
                    }
                }
                if (w.contains("retry_policy") && w["retry_policy"].is_object())
                {
                    const auto &rp = w["retry_policy"];
                    if (rp.value("max_retries", 0) < 0 || rp.value("max_retries", 0) > 10)
                    {
                        std::cerr << "[Validation Error] retry_policy max_retries must be between 0 and 10.\n";
                        return false;
                    }
                    if (rp.value("backoff_multiplier", 1.5) < 1.0 || rp.value("backoff_multiplier", 1.5) > 10.0)
                    {
                        std::cerr << "[Validation Error] retry_policy backoff_multiplier must be between 1.0 and 10.0.\n";
                        return false;
                    }
                }
            }

            // Chaos check (supports canonical 'chaos' and legacy 'events')
            const std::string chaos_key = scenario_json_.contains("chaos") ? "chaos" : (scenario_json_.contains("events") ? "events" : "");
            if (!chaos_key.empty() && scenario_json_[chaos_key].is_array())
            {
                for (const auto &c : scenario_json_[chaos_key])
                {
                    std::string type = c.value("type", "");
                    std::string target = c.value("target", "");
                    if (c.value("duration_ms", 0ULL) == 0)
                    {
                        std::cerr << "[Validation Error] Chaos event on target '" << target << "' must have duration_ms > 0.\n";
                        return false;
                    }
                    if ((type == "NODE_CRASH" || type == "CRASH_NODE") && !node_ids.count(target))
                    {
                        std::cerr << "[Validation Error] NODE_CRASH target node '" << target << "' does not exist.\n";
                        return false;
                    }
                    if ((type == "NETWORK_PARTITION" || type == "PARTITION_LINK") && !link_ids.count(target))
                    {
                        std::cerr << "[Validation Error] NETWORK_PARTITION target link '" << target << "' does not exist.\n";
                        return false;
                    }
                }
            }

            return true;
        }

        bool setup()
        {
            if (!validate_scenario())
            {
                return false;
            }

            uint32_t seed = scenario_json_.value("seed", 42);
            rng_.seed(seed);

            // 1. Construct Nodes
            for (const auto &n : scenario_json_["nodes"])
            {
                std::string id = n["id"];
                size_t concurrency = n.contains("concurrency") ? n.value("concurrency", 4) : n.value("workers", 4);
                size_t queue_cap = n.value("queue_capacity", 20);
                uint64_t svc_ms = n.contains("service_time_ms") ? n.value("service_time_ms", 10ULL) : n.value("processing_time_ms", 10ULL);
                SimTime service_time_us = MS_TO_US(svc_ms);

                nodes_[id] = std::make_unique<Node>(id, concurrency, queue_cap, service_time_us);
            }

            // 2. Construct Links
            for (const auto &l : scenario_json_["links"])
            {
                std::string id = l["id"];
                std::string src = l["source"];
                std::string tgt = l["target"];
                SimTime latency_us = MS_TO_US(l.value("latency_ms", 10ULL));
                SimTime jitter_us = MS_TO_US(l.value("jitter_ms", 2ULL));
                double drop_rate = l.value("drop_rate", 0.0);

                links_[id] = std::make_unique<NetworkLink>(id, src, tgt, latency_us, jitter_us, drop_rate, seed++);
            }

            // 3. Setup Traffic Generator (Workload) & Retry Policy
            if (scenario_json_.contains("workload"))
            {
                const auto &w = scenario_json_["workload"];
                double rps = w.value("requests_per_second", 50.0);
                SimTime interval_us = static_cast<SimTime>(1000000.0 / rps);
                SimTime start_us = MS_TO_US(w.value("start_time_ms", 0ULL));
                SimTime duration_us = MS_TO_US(w.value("duration_ms", 1000ULL));
                std::vector<std::string> route = w.value("route", std::vector<std::string>{});

                if (w.contains("retry_policy"))
                {
                    const auto &rp = w["retry_policy"];
                    retry_policy_.max_retries = rp.value("max_retries", 0);
                    retry_policy_.backoff_ms = rp.value("backoff_ms", 25ULL);
                    retry_policy_.backoff_multiplier = rp.value("backoff_multiplier", 1.5);
                    retry_policy_.jitter_ms = rp.value("jitter_ms", 5ULL);
                }

                SimTime cur_t = start_us;
                uint64_t req_id = 1;
                while (cur_t < start_us + duration_us)
                {
                    auto req = std::make_shared<Request>();
                    req->id = req_id++;
                    req->created_at = cur_t;
                    all_requests_.push_back(req);

                    scheduler_.schedule_at(cur_t, EventType::REQUEST_GENERATED, "client", req, [this, req, route]()
                                           { this->dispatch_request(req, route, 0); });

                    cur_t += interval_us;
                }
            }

            // 4. Setup Chaos Fault Events
            if (scenario_json_.contains("chaos"))
            {
                for (const auto &c : scenario_json_["chaos"])
                {
                    SimTime fault_time_us = MS_TO_US(c.value("time_ms", 0ULL));
                    SimTime duration_us = MS_TO_US(c.value("duration_ms", 500ULL));
                    std::string type = c.value("type", "");
                    std::string target = c.value("target", "");

                    if (type == "NODE_CRASH" && nodes_.count(target))
                    {
                        // Inject crash
                        scheduler_.schedule_at(fault_time_us, EventType::NODE_CRASH, target, nullptr, [this, target]()
                                               {
                        std::cout << "[CHAOS] Node crashed: " << target << "\n";
                        this->nodes_[target]->crash(); });
                        // Schedule reboot after duration
                        scheduler_.schedule_at(fault_time_us + duration_us, EventType::NODE_RECOVER, target, nullptr, [this, target]()
                                               {
                        std::cout << "[RECOVERY] Node recovered: " << target << "\n";
                        this->nodes_[target]->recover(); });
                    }
                    else if (type == "NETWORK_PARTITION" && links_.count(target))
                    {
                        // Cut link
                        scheduler_.schedule_at(fault_time_us, EventType::LINK_DEGRADE, target, nullptr, [this, target]()
                                               {
                        std::cout << "[CHAOS] Network partitioned: " << target << "\n";
                        this->links_[target]->partition(); });
                        // Heal link
                        scheduler_.schedule_at(fault_time_us + duration_us, EventType::LINK_RESTORE, target, nullptr, [this, target]()
                                               {
                        std::cout << "[RECOVERY] Network healed: " << target << "\n";
                        this->links_[target]->heal(); });
                    }
                }
            }

            return true;
        }

        void handle_failure(std::shared_ptr<Request> req, const std::vector<std::string> &route)
        {
            if (req->state == RequestState::SUCCEEDED)
            {
                return;
            }

            if (retry_policy_.max_retries > 0 && req->retry_count < retry_policy_.max_retries)
            {
                req->retry_count++;
                total_retries_++;
                SimTime base_backoff_us = MS_TO_US(static_cast<SimTime>(retry_policy_.backoff_ms * std::pow(retry_policy_.backoff_multiplier, req->retry_count - 1)));
                int64_t jitter_us = 0;
                if (retry_policy_.jitter_ms > 0)
                {
                    SimTime max_j_us = MS_TO_US(retry_policy_.jitter_ms);
                    std::uniform_int_distribution<int64_t> j_dist(-static_cast<int64_t>(max_j_us), static_cast<int64_t>(max_j_us));
                    jitter_us = j_dist(rng_);
                }
                int64_t effective_us = static_cast<int64_t>(base_backoff_us) + jitter_us;
                SimTime delay_us = (effective_us > 100) ? static_cast<SimTime>(effective_us) : 100ULL;

                scheduler_.schedule(delay_us, EventType::REQUEST_GENERATED, "client_retry", req, [this, req, route]()
                                    {
                    if (req->state != RequestState::SUCCEEDED)
                    {
                        req->state = RequestState::IN_FLIGHT;
                        req->is_failed = false;
                        this->dispatch_request(req, route, 0);
                    }
                });
                return;
            }

            req->state = RequestState::FAILED;
            req->is_failed = true;
            if (req->retry_count > 0 && req->retry_count >= retry_policy_.max_retries)
            {
                if (req->failure_reason.find("RETRIES_EXHAUSTED") == std::string::npos)
                {
                    req->failure_reason += " (RETRIES_EXHAUSTED)";
                }
            }
        }

        /**
         * Recursively traverses request across the route hops (Gateway -> Order -> Payment).
         * Each node's processing completion triggers the next hop link transmission.
         */
        void dispatch_request(std::shared_ptr<Request> req, const std::vector<std::string> &route, size_t hop_idx)
        {
            if (hop_idx >= route.size())
            {
                req->state = RequestState::SUCCEEDED;
                req->completed_at = scheduler_.current_time();
                return;
            }

            const std::string &current_node_id = route[hop_idx];
            auto &current_node = nodes_[current_node_id];

            current_node->receive_request(scheduler_, req, [this, route, hop_idx, current_node_id](std::shared_ptr<Request> processed_req)
            {
                if (processed_req->state == RequestState::FAILED || processed_req->is_failed)
                {
                    this->handle_failure(processed_req, route);
                    return;
                }

                // If there's a next hop, find the link connecting them
                if (hop_idx + 1 < route.size())
                {
                    const std::string &next_node_id = route[hop_idx + 1];
                    NetworkLink *found_link = nullptr;
                    for (auto &[id, link] : links_)
                    {
                        if (link->source_id() == current_node_id && link->target_id() == next_node_id)
                        {
                            found_link = link.get();
                            break;
                        }
                    }

                    if (found_link)
                    {
                        found_link->transmit(scheduler_, processed_req, [this, route, hop_idx](std::shared_ptr<Request> delivered_req)
                        {
                            if (delivered_req->state == RequestState::FAILED || delivered_req->is_failed)
                            {
                                this->handle_failure(delivered_req, route);
                                return;
                            }
                            this->dispatch_request(delivered_req, route, hop_idx + 1);
                        });
                    }
                    else
                    {
                        // Direct hop if no explicit link configured
                        this->dispatch_request(processed_req, route, hop_idx + 1);
                    }
                }
                else
                {
                    // All hops completed and final node finished processing
                    processed_req->state = RequestState::SUCCEEDED;
                    processed_req->completed_at = scheduler_.current_time();
                }
            });
        }

        Scheduler scheduler_;
        json scenario_json_;
        RetryPolicy retry_policy_;
        uint64_t total_retries_{0};
        std::mt19937 rng_;
        std::unordered_map<std::string, std::unique_ptr<Node>> nodes_;
        std::unordered_map<std::string, std::unique_ptr<NetworkLink>> links_;
        std::vector<std::shared_ptr<Request>> all_requests_;
    };

} // namespace faultline
#include "event.hpp"
#include "scheduler.hpp"
#include "node.hpp"
#include "link.hpp"
#include "scenario.hpp"
#include <cassert>
#include <iostream>
#include <sstream>

using namespace faultline;

// 1. Scheduler virtual clock ordering
void test_scheduler_ordering() {
    std::cout << "[TEST 1] Scheduler virtual clock ordering... ";
    Scheduler sched;
    std::vector<int> execution_order;

    sched.schedule_at(MS_TO_US(50), EventType::PROCESS_START, "n1", nullptr, [&]() {
        execution_order.push_back(3);
    });
    sched.schedule_at(MS_TO_US(10), EventType::PROCESS_START, "n1", nullptr, [&]() {
        execution_order.push_back(1);
    });
    sched.schedule_at(MS_TO_US(25), EventType::PROCESS_START, "n1", nullptr, [&]() {
        execution_order.push_back(2);
    });

    sched.run_until(MS_TO_US(100));

    assert(execution_order.size() == 3);
    assert(execution_order[0] == 1);
    assert(execution_order[1] == 2);
    assert(execution_order[2] == 3);
    assert(sched.current_time() == MS_TO_US(50));
    std::cout << "PASSED\n";
}

// 2. Equal timestamp deterministic FIFO tie-breaking
void test_equal_timestamp_fifo_ordering() {
    std::cout << "[TEST 2] Equal timestamp deterministic FIFO tie-breaking... ";
    Scheduler sched;
    std::vector<int> order;

    for (int i = 1; i <= 5; ++i) {
        sched.schedule_at(MS_TO_US(20), EventType::PROCESS_START, "n1", nullptr, [&order, i]() {
            order.push_back(i);
        });
    }

    sched.run_until(MS_TO_US(50));

    assert(order.size() == 5);
    for (int i = 0; i < 5; ++i) {
        assert(order[i] == i + 1);
    }
    std::cout << "PASSED\n";
}

// 3. Node queue capacity & backpressure
void test_node_queue_overflow() {
    std::cout << "[TEST 3] Node queue overflow & backpressure... ";
    Scheduler sched;
    // 1 worker, queue capacity 2 (Max 3 in node at once)
    Node node("test-node", 1, 2, MS_TO_US(10));

    for (int i = 1; i <= 4; ++i) {
        auto req = std::make_shared<Request>();
        req->id = i;
        sched.schedule_at(0, EventType::REQUEST_ARRIVED, "test-node", req, [&node, &sched, req]() {
            node.receive_request(sched, req);
        });
    }

    sched.run_until(MS_TO_US(1));

    // Request #4 must have failed due to queue full
    assert(node.stats().requests_received == 4);
    assert(node.stats().requests_dropped_queue_full == 1);
    assert(node.stats().peak_queue_depth == 2);
    std::cout << "PASSED\n";
}

// 4. Network link partition drop
void test_link_partition() {
    std::cout << "[TEST 4] Network link partition drop... ";
    Scheduler sched;
    NetworkLink link("link-1", "src", "dst", MS_TO_US(10), 0, 0.0, 42);
    link.partition();

    auto req = std::make_shared<Request>();
    bool callback_fired = false;
    link.transmit(sched, req, [&](std::shared_ptr<Request> r) {
        callback_fired = true;
        assert(r->state == RequestState::FAILED);
        assert(r->failure_reason == "NETWORK_PARTITION");
    });

    sched.run_until(MS_TO_US(50));

    assert(callback_fired);
    assert(req->is_failed);
    assert(req->failure_reason == "NETWORK_PARTITION");
    assert(link.stats().packets_dropped_partition == 1);
    std::cout << "PASSED\n";
}

// 5. Network link packet loss
void test_link_packet_loss() {
    std::cout << "[TEST 5] Network link packet loss failure... ";
    Scheduler sched;
    // 100% drop rate
    NetworkLink link("lossy-link", "src", "dst", MS_TO_US(10), 0, 1.0, 42);

    auto req = std::make_shared<Request>();
    bool callback_fired = false;
    link.transmit(sched, req, [&](std::shared_ptr<Request> r) {
        callback_fired = true;
        assert(r->state == RequestState::FAILED);
        assert(r->failure_reason == "PACKET_LOSS");
    });

    sched.run_until(MS_TO_US(50));

    assert(callback_fired);
    assert(req->is_failed);
    assert(link.stats().packets_dropped_loss == 1);
    std::cout << "PASSED\n";
}

// 6. Sequential service processing across hops
void test_sequential_service_hops() {
    std::cout << "[TEST 6] Sequential service processing across hops... ";
    Scheduler sched;
    Node node_a("node-a", 2, 10, MS_TO_US(10)); // 10ms service
    Node node_b("node-b", 2, 10, MS_TO_US(15)); // 15ms service
    NetworkLink link("link-ab", "node-a", "node-b", MS_TO_US(5), 0, 0.0, 42); // 5ms link latency

    auto req = std::make_shared<Request>();
    req->id = 101;
    req->created_at = 0;

    // Dispatch: Node A -> Link -> Node B
    node_a.receive_request(sched, req, [&](std::shared_ptr<Request> r1) {
        assert(sched.current_time() == MS_TO_US(10)); // Node A completes at 10ms
        link.transmit(sched, r1, [&](std::shared_ptr<Request> r2) {
            assert(sched.current_time() == MS_TO_US(15)); // Link delivers at 10+5 = 15ms
            node_b.receive_request(sched, r2, [&](std::shared_ptr<Request> r3) {
                assert(sched.current_time() == MS_TO_US(30)); // Node B finishes at 15+15 = 30ms
                r3->state = RequestState::SUCCEEDED;
                r3->completed_at = sched.current_time();
            });
        });
    });

    sched.run_until(MS_TO_US(100));

    assert(!req->is_failed);
    assert(req->state == RequestState::SUCCEEDED);
    assert(req->completed_at == MS_TO_US(30));
    assert(node_a.stats().requests_processed == 1);
    assert(node_b.stats().requests_processed == 1);
    assert(link.stats().packets_delivered == 1);
    std::cout << "PASSED (Completed at exactly 30ms)\n";
}

// 7. Explicit RequestState tracking & in-flight crash
void test_request_state_tracking() {
    std::cout << "[TEST 7] Explicit RequestState tracking & crash handling... ";
    Scheduler sched;
    Node node("crash-node", 1, 5, MS_TO_US(20)); // 20ms processing

    auto req = std::make_shared<Request>();
    req->id = 202;
    assert(req->state == RequestState::IN_FLIGHT);

    node.receive_request(sched, req);
    assert(req->state == RequestState::IN_FLIGHT);

    sched.schedule_at(MS_TO_US(10), EventType::NODE_CRASH, "crash-node", nullptr, [&node]() {
        node.crash();
    });

    sched.run_until(MS_TO_US(50));

    assert(req->state == RequestState::FAILED);
    assert(req->is_failed);
    assert(req->failure_reason == "NODE_CRASHED_DURING_PROCESS");
    std::cout << "PASSED\n";
}

// 8. Crash during processing followed by recovery before completion event
void test_crash_recovery_stale_event_invalidation() {
    std::cout << "[TEST 8] Crash followed by recovery before event fires (invalidation)... ";
    Scheduler sched;
    Node node("reboot-node", 1, 5, MS_TO_US(40)); // 40ms processing

    auto req = std::make_shared<Request>();
    req->id = 303;

    // t=0: request begins 40ms processing (scheduled to complete at t=40ms)
    node.receive_request(sched, req);
    assert(node.active_workers() == 1);

    // t=15ms: node crashes
    sched.schedule_at(MS_TO_US(15), EventType::NODE_CRASH, "reboot-node", nullptr, [&node]() {
        node.crash();
        assert(node.state() == NodeState::CRASHED);
        assert(node.active_workers() == 0);
    });

    // t=25ms: node recovers back to ONLINE before the t=40ms completion event!
    sched.schedule_at(MS_TO_US(25), EventType::NODE_RECOVER, "reboot-node", nullptr, [&node]() {
        node.recover();
        assert(node.state() == NodeState::ONLINE);
    });

    sched.run_until(MS_TO_US(60));

    // Stale event at t=40ms must be rejected, request must be FAILED
    assert(req->state == RequestState::FAILED);
    assert(req->is_failed);
    assert(req->failure_reason == "NODE_CRASHED_DURING_PROCESS");
    // active_workers must NOT have underflowed!
    assert(node.active_workers() == 0);
    assert(node.stats().requests_processed == 0);
    assert(node.stats().requests_dropped_crashed == 1);
    std::cout << "PASSED\n";
}

// 9. Crash queue eviction
void test_crash_queue_eviction() {
    std::cout << "[TEST 9] Crash queue eviction of waiting requests... ";
    Scheduler sched;
    // 1 worker, queue 5. 1 worker processing (50ms), 2 queued
    Node node("queue-node", 1, 5, MS_TO_US(50));

    auto req1 = std::make_shared<Request>(); req1->id = 1;
    auto req2 = std::make_shared<Request>(); req2->id = 2;
    auto req3 = std::make_shared<Request>(); req3->id = 3;

    node.receive_request(sched, req1);
    node.receive_request(sched, req2);
    node.receive_request(sched, req3);

    assert(node.active_workers() == 1);
    assert(node.current_queue_size() == 2);

    // Crash node at t=10ms
    sched.schedule_at(MS_TO_US(10), EventType::NODE_CRASH, "queue-node", nullptr, [&node]() {
        node.crash();
    });

    sched.run_until(MS_TO_US(70));

    assert(node.current_queue_size() == 0);
    assert(req2->state == RequestState::FAILED);
    assert(req2->failure_reason == "NODE_CRASHED_DURING_WAIT");
    assert(req3->state == RequestState::FAILED);
    assert(req3->failure_reason == "NODE_CRASHED_DURING_WAIT");
    std::cout << "PASSED\n";
}

// 10. Scenario validation rejects malformed inputs
void test_scenario_validation() {
    std::cout << "[TEST 10] Scenario validation rejection rules... ";

    // Missing nodes
    {
        SimulationEngine engine;
        json j = {{"duration_ms", 1000}};
        assert(!engine.load_scenario_from_json(j));
    }
    // Duplicate node IDs
    {
        SimulationEngine engine;
        json j = {
            {"duration_ms", 1000},
            {"nodes", {{{"id", "node1"}}, {{"id", "node1"}}}}
        };
        assert(!engine.load_scenario_from_json(j));
    }
    // Link references non-existent node
    {
        SimulationEngine engine;
        json j = {
            {"duration_ms", 1000},
            {"nodes", {{{"id", "node1"}}}},
            {"links", {{{"id", "l1"}, {"source", "node1"}, {"target", "ghost_node"}}}}
        };
        assert(!engine.load_scenario_from_json(j));
    }
    // Invalid negative duration
    {
        SimulationEngine engine;
        json j = {
            {"duration_ms", 0},
            {"nodes", {{{"id", "n1"}}}}
        };
        assert(!engine.load_scenario_from_json(j));
    }
    // Invalid drop rate > 1.0
    {
        SimulationEngine engine;
        json j = {
            {"duration_ms", 1000},
            {"nodes", {{{"id", "n1"}}, {{"id", "n2"}}}},
            {"links", {{{"id", "l1"}, {"source", "n1"}, {"target", "n2"}, {"drop_rate", 2.5}}}}
        };
        assert(!engine.load_scenario_from_json(j));
    }

    std::cout << "PASSED (All invalid inputs rejected)\n";
}

// 11. Deterministic simulation reproducibility with same seed
void test_scenario_reproducibility() {
    std::cout << "[TEST 11] Deterministic same-seed reproducibility... ";
    json scen = {
        {"name", "Deterministic Test"},
        {"seed", 1337},
        {"duration_ms", 500},
        {"nodes", {
            {{"id", "gw"}, {"concurrency", 4}, {"queue_capacity", 20}, {"service_time_ms", 5}},
            {{"id", "svc"}, {"concurrency", 2}, {"queue_capacity", 10}, {"service_time_ms", 15}}
        }},
        {"links", {
            {{"id", "l1"}, {"source", "gw"}, {"target", "svc"}, {"latency_ms", 10}, {"jitter_ms", 3}, {"drop_rate", 0.0}}
        }},
        {"workload", {
            {"requests_per_second", 40.0},
            {"start_time_ms", 0},
            {"duration_ms", 300},
            {"route", {"gw", "svc"}}
        }}
    };

    SimulationEngine engine1;
    assert(engine1.load_scenario_from_json(scen));
    engine1.run();

    SimulationEngine engine2;
    assert(engine2.load_scenario_from_json(scen));
    engine2.run();

    assert(engine1.scheduler().total_events_processed() == engine2.scheduler().total_events_processed());
    assert(engine1.scheduler().current_time() == engine2.scheduler().current_time());
    std::cout << "PASSED (Identical event trace count)\n";
}

int main() {
    std::cout << "=========================================================\n";
    std::cout << "  FAULTLINE: C++ SIMULATION ENGINE REGRESSION SUITE\n";
    std::cout << "=========================================================\n";

    test_scheduler_ordering();
    test_equal_timestamp_fifo_ordering();
    test_node_queue_overflow();
    test_link_partition();
    test_link_packet_loss();
    test_sequential_service_hops();
    test_request_state_tracking();
    test_crash_recovery_stale_event_invalidation();
    test_crash_queue_eviction();
    test_scenario_validation();
    test_scenario_reproducibility();

    std::cout << "\n=========================================================\n";
    std::cout << "  ALL 11 C++ REGRESSION TESTS PASSED! (11/11)\n";
    std::cout << "=========================================================\n";
    return 0;
}

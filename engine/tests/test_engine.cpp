#include "event.hpp"
#include "scheduler.hpp"
#include "node.hpp"
#include "link.hpp"
#include <cassert>
#include <iostream>

using namespace faultline;

void test_scheduler_ordering() {
    std::cout << "[TEST] Scheduler virtual clock ordering... ";
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

void test_node_queue_overflow() {
    std::cout << "[TEST] Node queue overflow & backpressure... ";
    Scheduler sched;
    // 1 worker, capacity 2 (Max 3 total)
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

void test_link_partition() {
    std::cout << "[TEST] Network link partition drop... ";
    Scheduler sched;
    NetworkLink link("link-1", "src", "dst", MS_TO_US(10), 0, 0.0, 42);
    link.partition();

    auto req = std::make_shared<Request>();
    bool delivered = false;
    link.transmit(sched, req, [&](std::shared_ptr<Request>) {
        delivered = true;
    });

    sched.run_until(MS_TO_US(50));

    assert(!delivered);
    assert(req->is_failed);
    assert(req->failure_reason == "NETWORK_PARTITION");
    assert(link.stats().packets_dropped_partition == 1);
    std::cout << "PASSED\n";
}

void test_sequential_service_hops() {
    std::cout << "[TEST] Sequential service processing across hops... ";
    Scheduler sched;
    Node node_a("node-a", 2, 10, MS_TO_US(10)); // 10ms service
    Node node_b("node-b", 2, 10, MS_TO_US(15)); // 15ms service
    NetworkLink link("link-ab", "node-a", "node-b", MS_TO_US(5), 0, 0.0, 42); // 5ms link latency

    auto req = std::make_shared<Request>();
    req->id = 101;
    req->created_at = 0;

    // Dispatch: Node A -> Link -> Node B
    node_a.receive_request(sched, req, [&](std::shared_ptr<Request> r1) {
        link.transmit(sched, r1, [&](std::shared_ptr<Request> r2) {
            node_b.receive_request(sched, r2, [&](std::shared_ptr<Request> r3) {
                r3->completed_at = sched.current_time();
            });
        });
    });

    sched.run_until(MS_TO_US(100));

    // Must finish at exactly 10ms (Node A) + 5ms (Link) + 15ms (Node B) = 30ms
    assert(!req->is_failed);
    assert(req->completed_at == MS_TO_US(30));
    assert(node_a.stats().requests_processed == 1);
    assert(node_b.stats().requests_processed == 1);
    assert(link.stats().packets_delivered == 1);
    std::cout << "PASSED (Completed at 30ms)\n";
}

void test_request_state_tracking() {
    std::cout << "[TEST] Explicit RequestState tracking & in-flight crash... ";
    Scheduler sched;
    Node node("crash-node", 1, 5, MS_TO_US(20)); // 20ms processing

    auto req = std::make_shared<Request>();
    req->id = 202;
    assert(req->state == RequestState::IN_FLIGHT);

    node.receive_request(sched, req);
    assert(req->state == RequestState::IN_FLIGHT);

    // Crash the node at 10ms (while worker is midway through 20ms processing)
    sched.schedule_at(MS_TO_US(10), EventType::NODE_CRASH, "crash-node", nullptr, [&node]() {
        node.crash();
    });

    sched.run_until(MS_TO_US(50));

    // When the 20ms completion event triggers, it detects node crashed, sets FAILED
    assert(req->state == RequestState::FAILED);
    assert(req->is_failed);
    assert(req->failure_reason == "NODE_CRASHED_DURING_PROCESS");
    std::cout << "PASSED (State=FAILED, reason=NODE_CRASHED_DURING_PROCESS)\n";
}

int main() {
    std::cout << "=========================================================\n";
    std::cout << "  RUNNING FAULTLINE C++ ENGINE UNIT TESTS\n";
    std::cout << "=========================================================\n";

    test_scheduler_ordering();
    test_node_queue_overflow();
    test_link_partition();
    test_sequential_service_hops();
    test_request_state_tracking();

    std::cout << "\nALL C++ UNIT TESTS PASSED! (5/5)\n";
    std::cout << "=========================================================\n";
    return 0;
}

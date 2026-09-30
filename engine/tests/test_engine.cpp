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

int main() {
    std::cout << "=========================================================\n";
    std::cout << "  RUNNING FAULTLINE C++ ENGINE UNIT TESTS\n";
    std::cout << "=========================================================\n";

    test_scheduler_ordering();
    test_node_queue_overflow();
    test_link_partition();

    std::cout << "\nALL C++ UNIT TESTS PASSED! (3/3)\n";
    std::cout << "=========================================================\n";
    return 0;
}

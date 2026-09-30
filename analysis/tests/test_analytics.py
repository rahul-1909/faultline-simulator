import unittest
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.analytics import analyze_results, compare_experiments

class TestAnalytics(unittest.TestCase):
    def setUp(self):
        self.sample_results = {
            "scenario_name": "Test Outage",
            "metrics": {
                "total_requests": 100,
                "successful_requests": 80,
                "failed_requests": 20,
                "availability_percent": 80.0,
                "failure_breakdown": {
                    "NODE_DOWN": 15,
                    "QUEUE_FULL": 5
                },
                "latency_ms": {
                    "min": 10.0,
                    "p50": 25.0,
                    "p95": 45.0,
                    "max": 60.0
                }
            },
            "nodes": {
                "gw": {"received": 100, "processed": 100, "dropped_crashed": 0, "dropped_queue_full": 0, "peak_queue_depth": 1},
                "pay": {"received": 80, "processed": 60, "dropped_crashed": 15, "dropped_queue_full": 5, "peak_queue_depth": 8}
            }
        }

    def test_analyze_results(self):
        diag = analyze_results(self.sample_results)
        self.assertEqual(diag["availability_percent"], 80.0)
        self.assertEqual(diag["bottleneck_diagnosis"]["primary_bottleneck_node"], "pay")
        self.assertEqual(diag["bottleneck_diagnosis"]["primary_failure_cause"], "NODE_DOWN")
        self.assertGreater(diag["reliability_index"], 0.0)
        self.assertEqual(diag["node_health_scores"]["gw"], 100.0)

    def test_compare_experiments(self):
        run_a = {"scenario_name": "No Retry", "metrics": {"availability_percent": 50.0, "latency_ms": {"p95": 80.0}, "failed_requests": 50}}
        run_b = {"scenario_name": "Circuit Breaker", "metrics": {"availability_percent": 90.0, "latency_ms": {"p95": 35.0}, "failed_requests": 10}}
        comp = compare_experiments(run_a, run_b)
        self.assertEqual(comp["comparison_summary"]["winning_strategy"], "B")
        self.assertEqual(comp["comparison_summary"]["availability_improvement_pct"], 40.0)
        self.assertEqual(comp["comparison_summary"]["p95_latency_delta_ms"], -45.0)

if __name__ == "__main__":
    unittest.main()

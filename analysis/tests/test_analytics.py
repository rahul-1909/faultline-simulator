import unittest
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.analytics import analyze_results, compare_experiments, validate_simulation_results
from app.consumer import validate_event_schema, process_event, start_consumer
from unittest.mock import patch, MagicMock
import tempfile

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
                    "p99": 55.0,
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
        self.assertEqual(len(diag["validation_warnings"]), 0)

    def test_validation_detects_inconsistent_counts(self):
        bad_results = {
            "metrics": {
                "total_requests": 100,
                "successful_requests": 70,
                "failed_requests": 10, # sum is 80 != 100
                "availability_percent": 70.0
            }
        }
        errors = validate_simulation_results(bad_results)
        self.assertTrue(any("Count mismatch" in e or "Inconsistent" in e for e in errors))

    def test_validation_detects_inverted_percentiles(self):
        bad_results = {
            "metrics": {
                "total_requests": 10,
                "successful_requests": 10,
                "failed_requests": 0,
                "availability_percent": 100.0,
                "latency_ms": {
                    "min": 5.0,
                    "p50": 50.0,
                    "p95": 20.0, # p95 < p50 (inverted!)
                    "p99": 60.0,
                    "max": 70.0
                }
            }
        }
        errors = validate_simulation_results(bad_results)
        self.assertTrue(any("percentile inversion" in e for e in errors))

    def test_analyze_empty_results(self):
        diag = analyze_results({})
        self.assertEqual(diag["availability_percent"], 0.0)
        self.assertEqual(diag["total_requests"], 0)
        self.assertEqual(diag["successful_requests"], 0)
        self.assertEqual(diag["failed_requests"], 0)
        self.assertIsNone(diag["bottleneck_diagnosis"]["primary_bottleneck_node"])
        self.assertEqual(diag["bottleneck_diagnosis"]["primary_failure_cause"], "NONE")
        self.assertEqual(diag["bottleneck_diagnosis"]["peak_queue_depth"], 0)
        self.assertEqual(diag["bottleneck_diagnosis"]["total_node_drops"], 0)

    def test_compare_experiments_modes(self):
        run_a = {"scenario_name": "No Retry", "metrics": {"availability_percent": 50.0, "latency_ms": {"p95": 80.0}, "failed_requests": 50, "total_retries": 0}}
        run_b = {"scenario_name": "Backoff", "metrics": {"availability_percent": 90.0, "latency_ms": {"p95": 35.0}, "failed_requests": 10, "total_retries": 25}}
        
        # Controlled retry mode
        comp_ctrl = compare_experiments(run_a, run_b, mode="controlled_retry")
        self.assertEqual(comp_ctrl["comparison_summary"]["winning_strategy"], "B")
        self.assertEqual(comp_ctrl["comparison_summary"]["availability_improvement_pct"], 40.0)
        self.assertEqual(comp_ctrl["comparison_summary"]["p95_latency_delta_ms"], -45.0)
        self.assertIn("Controlled Retry", comp_ctrl["mode_label"])
        self.assertIn("Strategy B outperformed", comp_ctrl["comparison_summary"]["trade_off_analysis"])

        # Architecture comparison mode
        comp_arch = compare_experiments(run_a, run_b, mode="architecture_comparison")
        self.assertIn("Architectural", comp_arch["mode_label"])

    def test_compare_tie(self):
        run_a = {"scenario_name": "Strat A", "metrics": {"availability_percent": 95.0, "latency_ms": {"p95": 20.0}, "failed_requests": 5}}
        run_b = {"scenario_name": "Strat B", "metrics": {"availability_percent": 95.0, "latency_ms": {"p95": 20.0}, "failed_requests": 5}}
        comp = compare_experiments(run_a, run_b)
        self.assertEqual(comp["comparison_summary"]["winning_strategy"], "TIE")
        self.assertEqual(comp["comparison_summary"]["availability_improvement_pct"], 0.0)
        self.assertEqual(comp["comparison_summary"]["p95_latency_delta_ms"], 0.0)

    def test_compare_latency_tiebreaker(self):
        run_a = {"scenario_name": "Strat A", "metrics": {"availability_percent": 95.0, "latency_ms": {"p95": 40.0}, "failed_requests": 5}}
        run_b = {"scenario_name": "Strat B", "metrics": {"availability_percent": 95.0, "latency_ms": {"p95": 25.0}, "failed_requests": 5}}
        comp = compare_experiments(run_a, run_b)
        self.assertEqual(comp["comparison_summary"]["winning_strategy"], "B")
        self.assertEqual(comp["comparison_summary"]["p95_latency_delta_ms"], -15.0)

    def test_consumer_schema_validation(self):
        valid_evt = {
            "event_id": "evt-123",
            "event_type": "EXPERIMENT_COMPLETED",
            "experiment_id": "exp-456",
            "timestamp": "2026-09-30T12:00:00Z"
        }
        self.assertTrue(validate_event_schema(valid_evt))

        invalid_evt = {
            "event_id": "evt-123",
            # missing event_type & experiment_id
            "timestamp": "2026-09-30T12:00:00Z"
        }
        self.assertFalse(validate_event_schema(invalid_evt))
        self.assertFalse(validate_event_schema("not a dict"))

    @patch("requests.get")
    def test_consumer_lifecycle_events(self, mock_get):
        # Mock analytics endpoint for EXPERIMENT_COMPLETED
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "analysis": {
                "reliability_index": 85.5,
                "bottleneck_diagnosis": {"primary_failure_cause": "NODE_DOWN"}
            }
        }
        mock_get.return_value = mock_response

        processed = set()

        # 1. EXPERIMENT_QUEUED
        queued_evt = {
            "event_id": "evt-q-1",
            "event_type": "EXPERIMENT_QUEUED",
            "experiment_id": "exp-test-1",
            "timestamp": "2026-09-30T12:00:00Z"
        }
        self.assertTrue(process_event(queued_evt, processed))
        self.assertIn("evt-q-1", processed)

        # Duplicate deduplication
        self.assertFalse(process_event(queued_evt, processed))

        # 2. EXPERIMENT_STARTED
        started_evt = {
            "event_id": "evt-s-1",
            "event_type": "EXPERIMENT_STARTED",
            "experiment_id": "exp-test-1",
            "timestamp": "2026-09-30T12:00:01Z"
        }
        self.assertTrue(process_event(started_evt, processed))

        # 3. EXPERIMENT_COMPLETED
        completed_evt = {
            "event_id": "evt-c-1",
            "event_type": "EXPERIMENT_COMPLETED",
            "experiment_id": "exp-test-1",
            "timestamp": "2026-09-30T12:00:10Z"
        }
        self.assertTrue(process_event(completed_evt, processed))
        mock_get.assert_called_once()

        # 4. EXPERIMENT_FAILED
        failed_evt = {
            "event_id": "evt-f-1",
            "event_type": "EXPERIMENT_FAILED",
            "experiment_id": "exp-test-2",
            "timestamp": "2026-09-30T12:00:05Z",
            "payload": {"error": "process exited with code 1"}
        }
        self.assertTrue(process_event(failed_evt, processed))

        # 5. EXPERIMENT_CANCELLED
        cancelled_evt = {
            "event_id": "evt-cn-1",
            "event_type": "EXPERIMENT_CANCELLED",
            "experiment_id": "exp-test-3",
            "timestamp": "2026-09-30T12:00:02Z",
            "payload": {"reason": "operator cancelled"}
        }
        self.assertTrue(process_event(cancelled_evt, processed))

    @patch("app.consumer.FALLBACK_STREAM_FILE")
    @patch("app.consumer.HEARTBEAT_FILE")
    def test_consumer_fallback_stream_integration(self, mock_heartbeat, mock_stream):
        with tempfile.NamedTemporaryFile(mode="w+", delete=False) as sf, \
             tempfile.NamedTemporaryFile(mode="w+", delete=False) as hf:
            stream_path = sf.name
            heartbeat_path = hf.name

            mock_stream.__str__ = lambda x: stream_path
            mock_heartbeat.__str__ = lambda x: heartbeat_path

            import json
            sample_evt = {
                "event_id": "evt-integ-1",
                "event_type": "EXPERIMENT_STARTED",
                "experiment_id": "exp-integ-1",
                "timestamp": "2026-09-30T12:00:00Z"
            }
            sf.write(json.dumps(sample_evt) + "\n")
            sf.flush()

            # Run 1 iteration of consumer
            with patch("app.consumer.FALLBACK_STREAM_FILE", stream_path), \
                 patch("app.consumer.HEARTBEAT_FILE", heartbeat_path), \
                 patch("app.consumer.KAFKA_AVAILABLE", False):
                start_consumer(poll_interval=0.01, max_iterations=1)

            # Check heartbeat file was updated
            with open(heartbeat_path, "r") as f:
                content = f.read().strip()
                self.assertTrue(len(content) > 0)
                self.assertGreater(float(content), 0.0)

        # Cleanup
        try:
            os.remove(stream_path)
            os.remove(heartbeat_path)
        except OSError:
            pass

if __name__ == "__main__":
    unittest.main()

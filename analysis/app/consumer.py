"""
Kafka / Redpanda Event Stream Consumer for Faultline Analytics.
Listens for simulation lifecycle events (e.g. EXPERIMENT_COMPLETED) published
by the Go Orchestrator, validating event schemas and calculating statistical diagnostics.
"""

import json
import time
import os
import requests
from typing import Set, Dict, Any, Optional

try:
    from kafka import KafkaConsumer
    KAFKA_AVAILABLE = True
except ImportError:
    KAFKA_AVAILABLE = False

KAFKA_BROKER = os.getenv("KAFKA_BROKER", "localhost:9092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "faultline.experiments")
KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "faultline-analytics-group")
ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://localhost:8080")
ANALYTICS_URL = os.getenv("ANALYTICS_URL", "http://localhost:8000")
FALLBACK_STREAM_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "orchestrator", "event_stream.jsonl")

def validate_event_schema(event: Any) -> bool:
    """Validates the standard Faultline SimulationLifecycleEvent schema."""
    if not isinstance(event, dict):
        return False
    required_fields = ["event_id", "event_type", "experiment_id", "timestamp"]
    return all(field in event and event[field] for field in required_fields)

def process_event(event: Dict[str, Any], processed_ids: Set[str]) -> bool:
    """Processes an event, returning True if processed, False if ignored/invalid."""
    if not validate_event_schema(event):
        return False

    event_id = event["event_id"]
    if event_id in processed_ids:
        return False

    processed_ids.add(event_id)
    event_type = event["event_type"]
    exp_id = event["experiment_id"]

    if event_type == "EXPERIMENT_COMPLETED":
        print(f"[EVENT CONSUMER] Received EXPERIMENT_COMPLETED for '{exp_id}'. Triggering analysis...")
        try:
            res = requests.get(f"{ANALYTICS_URL}/api/v1/experiments/{exp_id}/analysis", timeout=5.0)
            if res.status_code == 200:
                data = res.json()
                sri = data.get("analysis", {}).get("reliability_index")
                cause = data.get("analysis", {}).get("bottleneck_diagnosis", {}).get("primary_failure_cause")
                print(f"[EVENT CONSUMER] Diagnostics for '{exp_id}' complete | SRI: {sri}% | Primary Cause: {cause}")
                return True
            else:
                print(f"[EVENT CONSUMER] Analysis endpoint returned status {res.status_code} for '{exp_id}'")
        except Exception as e:
            print(f"[EVENT CONSUMER] Failed to request analysis for '{exp_id}': {e}")
    elif event_type == "EXPERIMENT_FAILED":
        err_msg = event.get("payload", {}).get("error", "Unknown error")
        print(f"[EVENT CONSUMER] Experiment '{exp_id}' FAILED: {err_msg}")
        return True
    elif event_type == "EXPERIMENT_CANCELLED":
        print(f"[EVENT CONSUMER] Experiment '{exp_id}' CANCELLED by operator.")
        return True
    elif event_type in ("EXPERIMENT_QUEUED", "EXPERIMENT_STARTED"):
        print(f"[EVENT CONSUMER] Experiment '{exp_id}' status update: {event_type}")
        return True

    return False

def start_consumer(poll_interval: float = 1.0, max_iterations: Optional[int] = None):
    processed_events: Set[str] = set()
    print(f"[EVENT CONSUMER] Starting Kafka consumer (Broker: {KAFKA_BROKER}, Topic: {KAFKA_TOPIC})...")

    consumer = None
    if KAFKA_AVAILABLE:
        try:
            consumer = KafkaConsumer(
                KAFKA_TOPIC,
                bootstrap_servers=[KAFKA_BROKER],
                group_id=KAFKA_GROUP_ID,
                value_deserializer=lambda m: json.loads(m.decode("utf-8")),
                auto_offset_reset="earliest",
                consumer_timeout_ms=1000,
                enable_auto_commit=True
            )
            print(f"[EVENT CONSUMER] Successfully connected to Kafka/Redpanda broker: {KAFKA_BROKER}")
        except Exception as e:
            print(f"[EVENT CONSUMER NOTICE] Kafka broker at {KAFKA_BROKER} not reachable ({e}). Falling back to local event stream.")
            consumer = None

    iterations = 0
    while max_iterations is None or iterations < max_iterations:
        iterations += 1

        # 1. Consume from Kafka broker if connected
        if consumer is not None:
            try:
                for message in consumer:
                    event = message.value
                    process_event(event, processed_events)
            except Exception as e:
                print(f"[EVENT CONSUMER] Kafka consume error: {e}")

        # 2. Check local fallback event stream file (for offline/standalone execution)
        if os.path.exists(FALLBACK_STREAM_FILE):
            try:
                with open(FALLBACK_STREAM_FILE, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            process_event(event, processed_events)
                        except json.JSONDecodeError:
                            continue
            except Exception as e:
                print(f"[EVENT CONSUMER ERROR] Reading fallback stream: {e}")

        time.sleep(poll_interval)

if __name__ == "__main__":
    start_consumer()

"""
Background Event Stream Consumer for Faultline Analytics.
Listens for EXPERIMENT_COMPLETED events emitted by the Go Orchestrator / Kafka
and automatically calculates reliability indices and bottleneck reports.
"""

import json
import time
import os
import requests
from typing import Set

EVENT_STREAM_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "orchestrator", "event_stream.jsonl")
ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://localhost:8080")
ANALYTICS_URL = os.getenv("ANALYTICS_URL", "http://localhost:8000")

def start_consumer(poll_interval: float = 1.0):
    processed_events: Set[str] = set()
    print("[EVENT CONSUMER] Started listening for simulation events...")

    while True:
        try:
            if os.path.exists(EVENT_STREAM_FILE):
                with open(EVENT_STREAM_FILE, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            event_id = event.get("event_id")
                            event_type = event.get("event_type")
                            exp_id = event.get("experiment_id")

                            if event_id and event_id not in processed_events:
                                processed_events.add(event_id)

                                if event_type == "EXPERIMENT_COMPLETED":
                                    print(f"[EVENT CONSUMER] Detected COMPLETED experiment: {exp_id}. Triggering auto-analysis...")
                                    res = requests.get(f"{ANALYTICS_URL}/api/v1/experiments/{exp_id}/analysis")
                                    if res.status_code == 200:
                                        data = res.json()
                                        sri = data.get("analysis", {}).get("reliability_index")
                                        cause = data.get("analysis", {}).get("bottleneck_diagnosis", {}).get("primary_failure_cause")
                                        print(f"[EVENT CONSUMER] Auto-Analysis Completed for {exp_id} | SRI: {sri}% | Primary Cause: {cause}")
                        except json.JSONDecodeError:
                            continue
        except Exception as e:
            print(f"[EVENT CONSUMER ERROR] {e}")

        time.sleep(poll_interval)

if __name__ == "__main__":
    start_consumer()

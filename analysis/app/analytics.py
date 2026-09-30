import numpy as np
from typing import Dict, Any, List

def analyze_results(results: Dict[str, Any]) -> Dict[str, Any]:
    """
    Computes deep statistical diagnostics, latency histograms, and bottleneck diagnosis
    from raw simulation results.
    """
    metrics = results.get("metrics", {})
    total_req = metrics.get("total_requests", 0)
    succ_req = metrics.get("successful_requests", 0)
    failed_req = metrics.get("failed_requests", 0)
    avail_pct = metrics.get("availability_percent", 0.0)
    latency_stats = metrics.get("latency_ms", {})
    nodes = results.get("nodes", {})
    links = results.get("links", {})
    failures = metrics.get("failure_breakdown", {})

    # 1. Bottleneck Node Analysis
    bottleneck_node = None
    max_drop = 0
    highest_queue = 0
    node_health_scores = {}

    for node_id, data in nodes.items():
        drops = data.get("dropped_crashed", 0) + data.get("dropped_queue_full", 0)
        q_depth = data.get("peak_queue_depth", 0)
        received = data.get("received", 1)

        # Health score: 100% minus drop percentage
        health = max(0.0, 100.0 - (drops / max(1, received) * 100.0))
        node_health_scores[node_id] = round(health, 2)

        if bottleneck_node is None or drops > max_drop or (drops == max_drop and q_depth > highest_queue):
            max_drop = drops
            highest_queue = q_depth
            bottleneck_node = node_id

    # 2. System Reliability Index (SRI)
    # Combines availability (70% weight) and latency compliance (30% weight)
    p95 = latency_stats.get("p95", 50.0)
    latency_score = 100.0 if p95 <= 50.0 else max(0.0, 100.0 - (p95 - 50.0) * 1.5)
    reliability_index = round((avail_pct * 0.70) + (latency_score * 0.30), 2)

    # 3. Categorized Chaos Impact
    primary_failure_cause = "NONE"
    if failures:
        primary_failure_cause = max(failures, key=failures.get)

    return {
        "reliability_index": reliability_index,
        "availability_percent": round(avail_pct, 2),
        "total_requests": total_req,
        "successful_requests": succ_req,
        "failed_requests": failed_req,
        "latency_summary": latency_stats,
        "bottleneck_diagnosis": {
            "primary_bottleneck_node": bottleneck_node,
            "peak_queue_depth": highest_queue,
            "total_node_drops": max_drop,
            "primary_failure_cause": primary_failure_cause
        },
        "node_health_scores": node_health_scores,
        "failure_attribution": failures
    }


def compare_experiments(exp_a: Dict[str, Any], exp_b: Dict[str, Any]) -> Dict[str, Any]:
    """
    Performs comparative A/B analysis between two simulation runs
    (e.g., Naive Retry vs Exponential Backoff / Circuit Breaker).
    """
    metrics_a = exp_a.get("metrics", {})
    metrics_b = exp_b.get("metrics", {})

    avail_a = metrics_a.get("availability_percent", 0.0)
    avail_b = metrics_b.get("availability_percent", 0.0)
    avail_delta = round(avail_b - avail_a, 2)

    p95_a = metrics_a.get("latency_ms", {}).get("p95", 0.0)
    p95_b = metrics_b.get("latency_ms", {}).get("p95", 0.0)
    p95_delta = round(p95_b - p95_a, 2)

    winner = "B" if avail_b > avail_a or (avail_b == avail_a and p95_b < p95_a) else "A"
    if avail_a == avail_b and p95_a == p95_b:
        winner = "TIE"

    return {
        "comparison_summary": {
            "strategy_a_name": exp_a.get("scenario_name", "Strategy A"),
            "strategy_b_name": exp_b.get("scenario_name", "Strategy B"),
            "winning_strategy": winner,
            "availability_improvement_pct": avail_delta,
            "p95_latency_delta_ms": p95_delta
        },
        "strategy_a": {
            "availability_percent": avail_a,
            "p95_latency_ms": p95_a,
            "failed_requests": metrics_a.get("failed_requests", 0)
        },
        "strategy_b": {
            "availability_percent": avail_b,
            "p95_latency_ms": p95_b,
            "failed_requests": metrics_b.get("failed_requests", 0)
        }
    }

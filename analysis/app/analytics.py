import math
from typing import Dict, Any, List, Optional

def validate_simulation_results(results: Dict[str, Any]) -> List[str]:
    """
    Strict validation of simulation result document.
    Returns a list of error strings; empty if completely valid.
    """
    errors: List[str] = []
    if not isinstance(results, dict):
        return ["Results payload must be a JSON dictionary."]

    metrics = results.get("metrics")
    if metrics is None or not isinstance(metrics, dict):
        errors.append("Missing required 'metrics' object in simulation results.")
        return errors

    total_req = metrics.get("total_requests")
    succ_req = metrics.get("successful_requests")
    failed_req = metrics.get("failed_requests")

    if total_req is None or not isinstance(total_req, int) or total_req < 0:
        errors.append("'total_requests' must be a non-negative integer.")
    if succ_req is None or not isinstance(succ_req, int) or succ_req < 0:
        errors.append("'successful_requests' must be a non-negative integer.")
    if failed_req is None or not isinstance(failed_req, int) or failed_req < 0:
        errors.append("'failed_requests' must be a non-negative integer.")

    if total_req is not None and succ_req is not None and failed_req is not None:
        if succ_req + failed_req != total_req:
            errors.append(f"Inconsistent request counts: successful ({succ_req}) + failed ({failed_req}) != total ({total_req}).")

    avail_pct = metrics.get("availability_percent")
    if avail_pct is not None:
        if not isinstance(avail_pct, (int, float)) or not (0.0 <= avail_pct <= 100.0) or not math.isfinite(avail_pct):
            errors.append(f"'availability_percent' must be a finite number between 0.0 and 100.0.")
        elif total_req is not None and total_req > 0 and succ_req is not None:
            expected_avail = (succ_req / total_req) * 100.0
            if abs(avail_pct - expected_avail) > 1.0:
                errors.append(f"Availability mismatch: reported {avail_pct}%, calculated from counts {expected_avail:.2f}%.")

    lat = metrics.get("latency_ms")
    if lat is not None and isinstance(lat, dict) and succ_req and succ_req > 0:
        p_keys = ["min", "p50", "p95", "p99", "max"]
        vals = []
        for k in p_keys:
            v = lat.get(k)
            if v is not None:
                if not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
                    errors.append(f"Latency percentile '{k}' must be a finite non-negative number.")
                else:
                    vals.append((k, float(v)))

        for i in range(len(vals) - 1):
            if vals[i][1] > vals[i + 1][1] + 1e-4:
                errors.append(f"Latency percentile inversion: {vals[i][0]} ({vals[i][1]}) > {vals[i + 1][0]} ({vals[i + 1][1]}).")

    return errors


def analyze_results(results: Dict[str, Any]) -> Dict[str, Any]:
    """
    Computes statistical diagnostics, reliability indexing (SRI),
    and node/link bottleneck diagnoses from validated simulation results.
    """
    validation_errors = validate_simulation_results(results) if results else []

    metrics = results.get("metrics", {}) if isinstance(results, dict) else {}
    total_req = metrics.get("total_requests", 0)
    succ_req = metrics.get("successful_requests", 0)
    failed_req = metrics.get("failed_requests", 0)
    total_retries = metrics.get("total_retries", 0)
    avail_pct = metrics.get("availability_percent", 0.0 if total_req == 0 else (succ_req / total_req) * 100.0)
    latency_stats = metrics.get("latency_ms", {})
    nodes = results.get("nodes", {}) if isinstance(results, dict) else {}
    links = results.get("links", {}) if isinstance(results, dict) else {}
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

        health = max(0.0, 100.0 - (drops / max(1, received) * 100.0))
        node_health_scores[node_id] = round(health, 2)

        if bottleneck_node is None or drops > max_drop or (drops == max_drop and q_depth > highest_queue):
            max_drop = drops
            highest_queue = q_depth
            bottleneck_node = node_id

    # 2. System Reliability Index (SRI)
    # Combines availability (70% weight) and latency compliance (30% weight)
    p95 = latency_stats.get("p95", 0.0)
    if total_req == 0 or succ_req == 0:
        latency_score = 0.0
    else:
        latency_score = 100.0 if p95 <= 50.0 else max(0.0, 100.0 - (p95 - 50.0) * 1.5)

    reliability_index = round((avail_pct * 0.70) + (latency_score * 0.30), 2) if total_req > 0 else 0.0

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
        "total_retries": total_retries,
        "latency_summary": latency_stats,
        "bottleneck_diagnosis": {
            "primary_bottleneck_node": bottleneck_node,
            "peak_queue_depth": highest_queue,
            "total_node_drops": max_drop,
            "primary_failure_cause": primary_failure_cause
        },
        "node_health_scores": node_health_scores,
        "failure_attribution": failures,
        "validation_warnings": validation_errors
    }


def compare_experiments(exp_a: Dict[str, Any], exp_b: Dict[str, Any], mode: str = "controlled_retry") -> Dict[str, Any]:
    """
    Performs comparative evaluation between two simulation runs.
    Supported modes:
      - 'controlled_retry': Identical architecture, where retries/backoff are the only intentional variable.
      - 'architecture_comparison': Compares overall configurations (concurrency, queues, policies).
    Sign convention:
      - availability_improvement_pct = avail_b - avail_a (> 0 means Strategy B improved availability)
      - p95_latency_delta_ms = p95_b - p95_a (< 0 means Strategy B is faster, > 0 means added latency)
    """
    metrics_a = exp_a.get("metrics", {}) if isinstance(exp_a, dict) else {}
    metrics_b = exp_b.get("metrics", {}) if isinstance(exp_b, dict) else {}

    avail_a = round(metrics_a.get("availability_percent", 0.0), 2)
    avail_b = round(metrics_b.get("availability_percent", 0.0), 2)
    avail_delta = round(avail_b - avail_a, 2)

    p95_a = round(metrics_a.get("latency_ms", {}).get("p95", 0.0), 2)
    p95_b = round(metrics_b.get("latency_ms", {}).get("p95", 0.0), 2)
    p95_delta = round(p95_b - p95_a, 2)

    retries_a = metrics_a.get("total_retries", 0)
    retries_b = metrics_b.get("total_retries", 0)

    # Winner decision rule:
    # Availability is prioritized (significant if >= 0.5% difference).
    # If availability is tied (diff < 0.5%), lower p95 latency wins.
    if abs(avail_delta) >= 0.5:
        winner = "B" if avail_delta > 0 else "A"
    elif abs(p95_delta) >= 1.0:
        winner = "B" if p95_delta < 0 else "A"
    else:
        winner = "TIE"

    # Trade-off analysis description
    if winner == "B":
        if p95_delta > 0:
            trade_off = (f"Strategy B improved availability by +{avail_delta}% at the cost of "
                         f"+{p95_delta}ms p95 latency overhead and {retries_b} retries.")
        else:
            trade_off = (f"Strategy B outperformed Strategy A in both availability (+{avail_delta}%) "
                         f"and p95 tail latency ({p95_delta}ms).")
    elif winner == "A":
        trade_off = (f"Strategy A retained superior resilience ({avail_a}% vs {avail_b}%). "
                     f"Strategy B introduced excessive latency or retry amplification.")
    else:
        trade_off = "Both strategies performed equivalently within measurement tolerance."

    mode_label = ("Controlled Retry Experiment (Identical Topology & Workload)"
                  if mode == "controlled_retry" else
                  "Architectural Configuration Comparison")

    return {
        "mode": mode,
        "mode_label": mode_label,
        "comparison_summary": {
            "strategy_a_name": exp_a.get("scenario_name", "Strategy A"),
            "strategy_b_name": exp_b.get("scenario_name", "Strategy B"),
            "winning_strategy": winner,
            "availability_improvement_pct": avail_delta,
            "p95_latency_delta_ms": p95_delta,
            "trade_off_analysis": trade_off
        },
        "strategy_a": {
            "availability_percent": avail_a,
            "p95_latency_ms": p95_a,
            "failed_requests": metrics_a.get("failed_requests", 0),
            "total_retries": retries_a
        },
        "strategy_b": {
            "availability_percent": avail_b,
            "p95_latency_ms": p95_b,
            "failed_requests": metrics_b.get("failed_requests", 0),
            "total_retries": retries_b
        }
    }

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Any, Optional
import httpx
import os

from app.analytics import analyze_results, compare_experiments, validate_simulation_results

app = FastAPI(
    title="Faultline Simulation Analytics Service",
    description="Statistical modeling, reliability indexing, and strategy A/B benchmarking for distributed systems simulations.",
    version="1.0.0"
)

# Enable CORS for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://localhost:8080")

analysis_request_count = 0
comparison_request_count = 0
last_sri = 0.0

class AnalyzePayload(BaseModel):
    results: Dict[str, Any]

class ComparePayload(BaseModel):
    experiment_a: Dict[str, Any]
    experiment_b: Dict[str, Any]
    mode: Optional[str] = "controlled_retry"

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "faultline-analytics",
        "orchestrator_target": ORCHESTRATOR_URL
    }

@app.get("/metrics")
def prometheus_metrics():
    """Prometheus exposition metrics for analytics scraping."""
    content = (
        "# HELP faultline_analytics_requests_total Total number of analysis calculations requested.\n"
        "# TYPE faultline_analytics_requests_total counter\n"
        f"faultline_analytics_requests_total {analysis_request_count}\n"
        "# HELP faultline_comparisons_total Total number of A/B strategy comparisons executed.\n"
        "# TYPE faultline_comparisons_total counter\n"
        f"faultline_comparisons_total {comparison_request_count}\n"
        "# HELP faultline_last_reliability_index System Reliability Index from the most recent analysis.\n"
        "# TYPE faultline_last_reliability_index gauge\n"
        f"faultline_last_reliability_index {last_sri:.2f}\n"
    )
    return Response(content=content, media_type="text/plain; version=0.0.4")

@app.post("/api/v1/analyze")
def analyze(payload: AnalyzePayload):
    """
    Computes reliability index, bottleneck diagnostics, and failure attribution
    from simulation results after strict validation.
    """
    global analysis_request_count, last_sri
    analysis_request_count += 1
    res = analyze_results(payload.results)
    last_sri = res.get("reliability_index", 0.0)
    return res

@app.post("/api/v1/compare")
def compare(payload: ComparePayload):
    """
    Compares two simulation runs under the same workload to measure which
    recovery or retry strategy won.
    """
    global comparison_request_count
    comparison_request_count += 1
    return compare_experiments(payload.experiment_a, payload.experiment_b, payload.mode or "controlled_retry")

@app.get("/api/v1/experiments/{experiment_id}/analysis")
async def analyze_orchestrator_experiment(experiment_id: str):
    """
    Direct bridge to Go Orchestrator: Fetches results for a given experiment ID
    and computes full statistical diagnostics automatically.
    """
    global analysis_request_count, last_sri
    async with httpx.AsyncClient() as client:
        try:
            res = await client.get(f"{ORCHESTRATOR_URL}/api/v1/experiments/{experiment_id}")
            if res.status_code != 200:
                raise HTTPException(status_code=res.status_code, detail=f"Orchestrator returned error: {res.text}")

            exp_data = res.json()
            results = exp_data.get("results")
            if not results:
                raise HTTPException(status_code=400, detail="Experiment does not have results yet (may still be running)")

            analysis = analyze_results(results)
            analysis_request_count += 1
            last_sri = analysis.get("reliability_index", 0.0)

            return {
                "experiment_id": experiment_id,
                "name": exp_data.get("name"),
                "status": exp_data.get("status"),
                "analysis": analysis,
                "raw_results": results
            }
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Failed to reach Go Orchestrator at {ORCHESTRATOR_URL}: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)

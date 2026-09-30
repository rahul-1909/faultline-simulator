import React, { useState, useEffect } from 'react';
import { 
  Activity, AlertCircle, AlertTriangle, CheckCircle2, ChevronRight, 
  Flame, Gauge, Info, Layers, Play, RefreshCw, RotateCcw, Server, 
  ShieldAlert, ShieldCheck, Terminal, Trophy, GitCompare, Sliders, HelpCircle,
  Hash, ArrowUpRight, XCircle
} from 'lucide-react';

const ORCHESTRATOR_URL = (import.meta as any).env?.VITE_ORCHESTRATOR_URL || 'http://localhost:8080';
const ANALYTICS_URL = (import.meta as any).env?.VITE_ANALYTICS_URL || 'http://localhost:8000';

interface ExperimentSummary {
  id: string;
  name: string;
  status: string;
  duration_ms: number;
  created_at: string;
}

interface AnalysisData {
  reliability_index: number;
  availability_percent: number;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  latency_summary: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  bottleneck_diagnosis: {
    primary_bottleneck_node: string;
    peak_queue_depth: number;
    total_node_drops: number;
    primary_failure_cause: string;
  };
  node_health_scores: Record<string, number>;
  failure_attribution: Record<string, number>;
}

interface ComparisonResult {
  mode: string;
  mode_label: string;
  comparison_summary: {
    strategy_a_name: string;
    strategy_b_name: string;
    winning_strategy: 'A' | 'B' | 'TIE';
    availability_improvement_pct: number;
    p95_latency_delta_ms: number;
    trade_off_analysis: string;
  };
  strategy_a: {
    availability_percent: number;
    p95_latency_ms: number;
    failed_requests: number;
    total_retries?: number;
  };
  strategy_b: {
    availability_percent: number;
    p95_latency_ms: number;
    failed_requests: number;
    total_retries?: number;
  };
}

export default function App() {
  // Service Health & Execution Readiness
  const [orchestratorLive, setOrchestratorLive] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [engineStatus, setEngineStatus] = useState<string>('checking');
  const [analyticsLive, setAnalyticsLive] = useState(false);

  // Experiment & Diagnostics State
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [selectedExpId, setSelectedExpId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [rawResults, setRawResults] = useState<any>(null);

  // Run Lifecycle State: strictly handles completed, failed, cancelled, timed_out
  const [runState, setRunState] = useState<'idle' | 'running' | 'polling' | 'completed' | 'failed' | 'cancelled' | 'timed_out'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'topology' | 'telemetry' | 'comparison'>('topology');
  const [showExplainer, setShowExplainer] = useState(false);

  // Chaos Experiment Configuration
  const [preset, setPreset] = useState<'outage' | 'retry_storm' | 'partition_only' | 'healthy'>('outage');
  const [rps, setRps] = useState<number>(80);
  const [seed, setSeed] = useState<number>(42);
  const [crashPayment, setCrashPayment] = useState<boolean>(true);
  const [cutNetwork, setCutNetwork] = useState<boolean>(true);
  const [enableRetries, setEnableRetries] = useState<boolean>(false);
  const [maxRetries, setMaxRetries] = useState<number>(2);

  // Dynamic A/B Comparison State
  const [comparisonMode, setComparisonMode] = useState<'controlled_retry' | 'architecture_comparison'>('controlled_retry');
  const [comparisonData, setComparisonData] = useState<ComparisonResult | null>(null);
  const [isComparing, setIsComparing] = useState(false);

  // Preset switching logic
  const handlePresetChange = (newPreset: 'outage' | 'retry_storm' | 'partition_only' | 'healthy') => {
    setPreset(newPreset);
    if (newPreset === 'outage') {
      setRps(80);
      setCrashPayment(true);
      setCutNetwork(true);
      setEnableRetries(false);
    } else if (newPreset === 'retry_storm') {
      setRps(120);
      setCrashPayment(true);
      setCutNetwork(false);
      setEnableRetries(true);
      setMaxRetries(3);
    } else if (newPreset === 'partition_only') {
      setRps(80);
      setCrashPayment(false);
      setCutNetwork(true);
      setEnableRetries(false);
    } else if (newPreset === 'healthy') {
      setRps(60);
      setCrashPayment(false);
      setCutNetwork(false);
      setEnableRetries(false);
    }
  };

  // Health checks: distinguishes service ping from actual C++ engine executable readiness
  const checkHealth = async () => {
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/health`);
      if (res.ok) {
        const data = await res.json();
        setOrchestratorLive(true);
        setEngineReady(Boolean(data.engine_ready));
        setEngineStatus(data.engine_status || (data.engine_ready ? 'ready' : 'unavailable'));
      } else {
        setOrchestratorLive(false);
        setEngineReady(false);
        setEngineStatus('unreachable');
      }
    } catch {
      setOrchestratorLive(false);
      setEngineReady(false);
      setEngineStatus('offline');
    }

    try {
      const res = await fetch(`${ANALYTICS_URL}/health`);
      setAnalyticsLive(res.ok);
    } catch {
      setAnalyticsLive(false);
    }
  };

  // Fetch past experiments
  const fetchExperiments = async () => {
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/api/v1/experiments`);
      if (res.ok) {
        const data = await res.json();
        setExperiments(data.experiments || []);
        if (data.experiments && data.experiments.length > 0 && !selectedExpId) {
          loadAnalysis(data.experiments[0].id);
        }
      }
    } catch (e) {
      console.error("Error fetching experiments:", e);
    }
  };

  // Load analysis for a specific experiment
  const loadAnalysis = async (expId: string) => {
    setSelectedExpId(expId);
    setErrorMessage(null);
    try {
      const res = await fetch(`${ANALYTICS_URL}/api/v1/experiments/${expId}/analysis`);
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis);
        setRawResults(data.raw_results);
      } else {
        const errText = await res.text();
        setErrorMessage(`Analytics lookup failed (${res.status}): ${errText}`);
      }
    } catch (e: any) {
      console.error("Error fetching analysis:", e);
      setErrorMessage(`Cannot reach analytics service: ${e.message}`);
    }
  };

  // Trigger simulation run with polling for async completion
  const triggerSimulation = async () => {
    setRunState('running');
    setErrorMessage(null);

    try {
      const chaosEvents: any[] = [];
      if (crashPayment) {
        chaosEvents.push({
          time_ms: 300,
          type: "NODE_CRASH",
          target: "payment-service",
          duration_ms: 250
        });
      }
      if (cutNetwork) {
        chaosEvents.push({
          time_ms: 600,
          type: "NETWORK_PARTITION",
          target: "link-order-payment",
          duration_ms: 150
        });
      }

      const workload: any = {
        requests_per_second: rps,
        start_time_ms: 0,
        duration_ms: 800,
        route: ["api-gateway", "order-service", "payment-service"]
      };

      if (enableRetries && maxRetries > 0) {
        workload.retry_policy = {
          max_retries: maxRetries,
          backoff_ms: 25,
          backoff_multiplier: 1.5,
          jitter_ms: 5
        };
      }

      const payload = {
        name: `${preset === 'healthy' ? 'Healthy Baseline' : preset === 'retry_storm' ? 'Retry Storm Outage' : 'Black Friday Outage'} (${rps} RPS, Seed ${seed})`,
        scenario: {
          name: `Simulation (${rps} RPS)`,
          seed: Number(seed) || 42,
          duration_ms: 1000,
          nodes: [
            { id: "api-gateway", concurrency: 8, queue_capacity: 50, service_time_ms: 2 },
            { id: "order-service", concurrency: 4, queue_capacity: 20, service_time_ms: 10 },
            { id: "payment-service", concurrency: 2, queue_capacity: 10, service_time_ms: 25 }
          ],
          links: [
            { id: "link-gw-order", source: "api-gateway", target: "order-service", latency_ms: 5, jitter_ms: 1, drop_rate: 0.0 },
            { id: "link-order-payment", source: "order-service", target: "payment-service", latency_ms: 10, jitter_ms: 2, drop_rate: 0.0 }
          ],
          workload,
          chaos: chaosEvents
        }
      };

      const res = await fetch(`${ORCHESTRATOR_URL}/api/v1/experiments?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Orchestrator returned ${res.status}: ${err}`);
      }

      let data = await res.json();
      const expId = data.id;

      // Handle async 202 Accepted polling if not finished immediately
      if (res.status === 202 || data.status === 'RUNNING' || data.status === 'QUEUED') {
        setRunState('polling');
        let finished = false;
        let attempts = 0;
        while (!finished && attempts < 30) {
          await new Promise((r) => setTimeout(r, 400));
          const check = await fetch(`${ORCHESTRATOR_URL}/api/v1/experiments/${expId}`);
          if (check.ok) {
            const expData = await check.json();
            if (expData.status === 'COMPLETED' || expData.status === 'FAILED' || expData.status === 'CANCELLED') {
              finished = true;
              data = expData;
              break;
            }
          }
          attempts++;
        }

        if (!finished) {
          setRunState('timed_out');
          setErrorMessage('Simulation polling timed out after 12s. The experiment may still be running in the background.');
          await fetchExperiments();
          return;
        }
      }

      await fetchExperiments();

      if (data.status === 'FAILED') {
        setRunState('failed');
        setErrorMessage(data.error || 'Simulation engine execution reported failure.');
        return;
      }

      if (data.status === 'CANCELLED') {
        setRunState('cancelled');
        setErrorMessage(data.error || 'Simulation run was cancelled.');
        return;
      }

      if (data.status === 'COMPLETED') {
        await loadAnalysis(expId);
        setRunState('completed');
      }
    } catch (err: any) {
      console.error("Simulation run error:", err);
      setErrorMessage(err.message || 'Simulation execution failed.');
      setRunState('failed');
    }
  };

  // Run dynamic A/B comparison
  const runLiveComparison = async () => {
    setIsComparing(true);
    setErrorMessage(null);
    try {
      let expA: any;
      let expB: any;

      if (comparisonMode === 'controlled_retry') {
        // Controlled Retry Experiment: ONLY retry_policy varies!
        // Identical nodes, identical concurrency, identical queue capacities, identical links, identical seed, identical chaos schedule.
        const sharedTopology = {
          seed: Number(seed) || 42,
          duration_ms: 1000,
          nodes: [
            { id: "api-gateway", concurrency: 6, queue_capacity: 30, service_time_ms: 2 },
            { id: "order-service", concurrency: 4, queue_capacity: 20, service_time_ms: 10 },
            { id: "payment-service", concurrency: 2, queue_capacity: 10, service_time_ms: 25 }
          ],
          links: [
            { id: "link-gw-order", source: "api-gateway", target: "order-service", latency_ms: 5, jitter_ms: 1, drop_rate: 0.0 },
            { id: "link-order-payment", source: "order-service", target: "payment-service", latency_ms: 10, jitter_ms: 2, drop_rate: 0.0 }
          ],
          chaos: [
            { time_ms: 300, type: "NODE_CRASH", target: "payment-service", duration_ms: 250 }
          ]
        };

        const payloadA = {
          name: `Controlled: Strategy A (No Retries, ${rps} RPS)`,
          scenario: {
            ...sharedTopology,
            name: "Strategy A: No Retries",
            workload: {
              requests_per_second: rps,
              start_time_ms: 0,
              duration_ms: 800,
              route: ["api-gateway", "order-service", "payment-service"],
              retry_policy: { max_retries: 0 }
            }
          }
        };

        const payloadB = {
          name: `Controlled: Strategy B (Bounded Backoff, ${rps} RPS)`,
          scenario: {
            ...sharedTopology,
            name: "Strategy B: Bounded Backoff + Jitter",
            workload: {
              requests_per_second: rps,
              start_time_ms: 0,
              duration_ms: 800,
              route: ["api-gateway", "order-service", "payment-service"],
              retry_policy: {
                max_retries: 2,
                backoff_ms: 25,
                backoff_multiplier: 1.5,
                jitter_ms: 5
              }
            }
          }
        };

        const resA = await fetch(`${ORCHESTRATOR_URL}/api/v1/experiments?wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadA)
        });
        if (!resA.ok) throw new Error("Strategy A run failed on orchestrator.");
        expA = await resA.json();

        const resB = await fetch(`${ORCHESTRATOR_URL}/api/v1/experiments?wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadB)
        });
        if (!resB.ok) throw new Error("Strategy B run failed on orchestrator.");
        expB = await resB.json();

      } else {
        // Architecture Comparison Mode: Different architectural configurations
        const payloadA = {
          name: `Architecture: Strategy A Baseline (${rps} RPS)`,
          scenario: {
            name: "Strategy A: Naive Baseline",
            seed: Number(seed) || 42,
            duration_ms: 1000,
            nodes: [
              { id: "api-gateway", concurrency: 4, queue_capacity: 15, service_time_ms: 2 },
              { id: "order-service", concurrency: 2, queue_capacity: 10, service_time_ms: 10 },
              { id: "payment-service", concurrency: 1, queue_capacity: 5, service_time_ms: 25 }
            ],
            links: [
              { id: "link-gw-order", source: "api-gateway", target: "order-service", latency_ms: 5, jitter_ms: 1, drop_rate: 0.0 },
              { id: "link-order-payment", source: "order-service", target: "payment-service", latency_ms: 10, jitter_ms: 2, drop_rate: 0.0 }
            ],
            workload: {
              requests_per_second: rps,
              start_time_ms: 0,
              duration_ms: 800,
              route: ["api-gateway", "order-service", "payment-service"]
            },
            chaos: [
              { time_ms: 300, type: "NODE_CRASH", target: "payment-service", duration_ms: 250 }
            ]
          }
        };

        const payloadB = {
          name: `Architecture: Strategy B Resilient (${rps} RPS)`,
          scenario: {
            name: "Strategy B: Scaled & Resilient",
            seed: Number(seed) || 42,
            duration_ms: 1000,
            nodes: [
              { id: "api-gateway", concurrency: 8, queue_capacity: 50, service_time_ms: 2 },
              { id: "order-service", concurrency: 4, queue_capacity: 25, service_time_ms: 10 },
              { id: "payment-service", concurrency: 2, queue_capacity: 15, service_time_ms: 25 }
            ],
            links: [
              { id: "link-gw-order", source: "api-gateway", target: "order-service", latency_ms: 5, jitter_ms: 1, drop_rate: 0.0 },
              { id: "link-order-payment", source: "order-service", target: "payment-service", latency_ms: 10, jitter_ms: 2, drop_rate: 0.0 }
            ],
            workload: {
              requests_per_second: rps,
              start_time_ms: 0,
              duration_ms: 800,
              route: ["api-gateway", "order-service", "payment-service"],
              retry_policy: {
                max_retries: 2,
                backoff_ms: 25,
                backoff_multiplier: 1.5,
                jitter_ms: 5
              }
            },
            chaos: [
              { time_ms: 300, type: "NODE_CRASH", target: "payment-service", duration_ms: 250 }
            ]
          }
        };

        const resA = await fetch(`${ORCHESTRATOR_URL}/api/v1/experiments?wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadA)
        });
        if (!resA.ok) throw new Error("Strategy A run failed on orchestrator.");
        expA = await resA.json();

        const resB = await fetch(`${ORCHESTRATOR_URL}/api/v1/experiments?wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadB)
        });
        if (!resB.ok) throw new Error("Strategy B run failed on orchestrator.");
        expB = await resB.json();
      }

      if (expA.status !== 'COMPLETED') {
        throw new Error(`Strategy A failed: ${expA.error || expA.status}`);
      }
      if (expB.status !== 'COMPLETED') {
        throw new Error(`Strategy B failed: ${expB.error || expB.status}`);
      }

      const resultsA = typeof expA.results === 'string' ? JSON.parse(expA.results) : expA.results;
      const resultsB = typeof expB.results === 'string' ? JSON.parse(expB.results) : expB.results;

      const compRes = await fetch(`${ANALYTICS_URL}/api/v1/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experiment_a: resultsA,
          experiment_b: resultsB,
          mode: comparisonMode
        })
      });

      if (!compRes.ok) {
        const err = await compRes.text();
        throw new Error(`Analytics compare returned ${compRes.status}: ${err}`);
      }

      const compData = await compRes.json();
      setComparisonData(compData);
      await fetchExperiments();
    } catch (e: any) {
      console.error("Comparison error:", e);
      setErrorMessage(e.message || "Failed to execute A/B strategy benchmark.");
    } finally {
      setIsComparing(false);
    }
  };

  useEffect(() => {
    checkHealth();
    fetchExperiments();
    const interval = setInterval(checkHealth, 4000);
    return () => clearInterval(interval);
  }, []);

  // Compute incident assessment from actual results
  const renderIncidentAssessment = () => {
    if (!analysis) return null;
    const avail = analysis.availability_percent;
    const drops = analysis.failed_requests;
    const total = analysis.total_requests;
    const culprit = analysis.bottleneck_diagnosis.primary_bottleneck_node || 'link-order-payment';
    const cause = analysis.bottleneck_diagnosis.primary_failure_cause || 'NONE';

    if (avail === 100) {
      return {
        title: "System Healthy: Normal Operations",
        sev: "SEV-4 HEALTHY",
        badgeStyle: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
        icon: <ShieldCheck className="w-5 h-5 text-emerald-400" />,
        description: `100% of ${total} requests fulfilled across all hops with 0 drops and zero queue backpressure.`
      };
    } else if (avail >= 90) {
      return {
        title: `Partial Degradation: ${avail}% Uptime (${drops} Dropped)`,
        sev: "SEV-3 MODERATE",
        badgeStyle: "bg-amber-500/20 text-amber-300 border border-amber-500/30",
        icon: <AlertTriangle className="w-5 h-5 text-amber-400" />,
        description: `${drops} of ${total} requests failed. Primary bottleneck: ${culprit} (${cause}). System absorbed most load successfully.`
      };
    } else {
      return {
        title: `Major Incident: Outage on ${culprit} (${avail}% Availability)`,
        sev: "SEV-1 CRITICAL",
        badgeStyle: "bg-rose-500/20 text-rose-300 border border-rose-500/30",
        icon: <AlertCircle className="w-5 h-5 text-rose-400" />,
        description: `Severe failure: ${drops} of ${total} requests dropped (${(100 - avail).toFixed(1)}% drop rate). Cause: ${cause}.`
      };
    }
  };

  const incident = renderIncidentAssessment();

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-200 flex flex-col font-sans selection:bg-rose-500 selection:text-white">
      
      {/* Navigation Header */}
      <header className="border-b border-white/10 bg-[#0d131f]/90 backdrop-blur-md px-6 py-3.5 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-rose-600 to-rose-400 flex items-center justify-center shadow-lg shadow-rose-600/30">
            <Flame className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-extrabold tracking-tight text-white font-mono">FAULTLINE</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                DISTRIBUTED DES ENGINE
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              First-principles discrete-event simulator for microservice failure cascades
            </p>
          </div>
        </div>

        {/* Real System Health Checks */}
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setShowExplainer(!showExplainer)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 px-3 py-1.5 rounded-lg border border-white/5 transition-all"
          >
            <HelpCircle className="w-3.5 h-3.5 text-rose-400" />
            <span className="hidden md:inline">How It Works</span>
          </button>

          {/* C++ Engine Verified Execution Check */}
          <div className="hidden lg:flex items-center gap-2 text-xs bg-slate-900/60 px-3 py-1.5 rounded-lg border border-white/5">
            <div className={`w-2 h-2 rounded-full ${engineReady ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></div>
            <span className="text-slate-400">C++ Engine:</span>
            <span className={`font-semibold font-mono ${engineReady ? 'text-emerald-400' : 'text-rose-400'}`}>
              {engineReady ? 'Ready' : engineStatus}
            </span>
          </div>

          {/* Go Orchestrator Health */}
          <div className="hidden lg:flex items-center gap-2 text-xs bg-slate-900/60 px-3 py-1.5 rounded-lg border border-white/5">
            <div className={`w-2 h-2 rounded-full ${orchestratorLive ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></div>
            <span className="text-slate-400">Go Orchestrator:</span>
            <span className={`font-semibold font-mono ${orchestratorLive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {orchestratorLive ? ':8080' : 'Offline'}
            </span>
          </div>

          {/* FastAPI Analytics Health */}
          <div className="hidden lg:flex items-center gap-2 text-xs bg-slate-900/60 px-3 py-1.5 rounded-lg border border-white/5">
            <div className={`w-2 h-2 rounded-full ${analyticsLive ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></div>
            <span className="text-slate-400">FastAPI:</span>
            <span className={`font-semibold font-mono ${analyticsLive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {analyticsLive ? ':8000' : 'Offline'}
            </span>
          </div>

          <button
            onClick={triggerSimulation}
            disabled={runState === 'running' || runState === 'polling' || !orchestratorLive || !engineReady}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-xs shadow-lg transition-all ${
              runState === 'running' || runState === 'polling'
                ? 'bg-slate-700 text-slate-300 cursor-not-allowed' 
                : !orchestratorLive || !engineReady
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-white/5'
                : 'bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white shadow-rose-600/30 active:scale-95'
            }`}
          >
            {runState === 'running' || runState === 'polling' ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>{runState === 'running' ? 'Simulating...' : 'Collecting Metrics...'}</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Run Chaos Simulation</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Explainer Drawer */}
      {showExplainer && (
        <div className="bg-gradient-to-r from-slate-900 via-rose-950/30 to-slate-900 border-b border-rose-500/20 px-6 py-4">
          <div className="max-w-6xl mx-auto flex items-start justify-between gap-6">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-lg bg-rose-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Info className="w-4 h-4 text-rose-400" />
              </div>
              <div className="text-xs space-y-1.5 text-slate-300">
                <p className="font-bold text-white text-sm">
                  Deterministic Distributed Failure Simulation
                </p>
                <p>
                  Distributed systems architectures cannot safely crash critical database or payment nodes in production.
                  Faultline is a virtual testbench modeled in a high-performance C++ discrete-event core: it executes virtual clocks, thread concurrency pools, bounded ingress queues, and network packet propagation.
                </p>
                <p className="text-slate-400">
                  Select an experiment preset, configure load and chaos events, then click <strong className="text-rose-400">"Run Chaos Simulation"</strong> to inspect microsecond-accurate service latencies and failure distributions.
                </p>
              </div>
            </div>
            <button 
              onClick={() => setShowExplainer(false)}
              className="text-slate-400 hover:text-white text-xs px-2.5 py-1 rounded bg-slate-800/80 hover:bg-slate-700"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Visible Error Notification Banner */}
      {errorMessage && (
        <div className="bg-rose-950/80 border-b border-rose-500/50 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-rose-200">
            <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={triggerSimulation}
              className="text-xs px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded font-medium flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Retry</span>
            </button>
            <button 
              onClick={() => setErrorMessage(null)}
              className="text-xs text-rose-300 hover:text-white px-2 py-1"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-6 flex flex-col gap-6">
        
        {/* Interactive Chaos Studio Controls Bar */}
        <section className="bg-[#0d131f] border border-white/10 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-xl">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Sliders className="w-4 h-4 text-rose-400" />
              <span>Presets:</span>
            </div>
            
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handlePresetChange('outage')}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  preset === 'outage' 
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold' 
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                }`}
              >
                🛍️ Black Friday Outage
              </button>
              
              <button
                onClick={() => handlePresetChange('retry_storm')}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  preset === 'retry_storm' 
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold' 
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                }`}
              >
                🌊 Retry Storm Under Outage (120 RPS + Retries)
              </button>

              <button
                onClick={() => handlePresetChange('partition_only')}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  preset === 'partition_only' 
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 font-bold' 
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                }`}
              >
                🌐 Network Partition Only
              </button>

              <button
                onClick={() => handlePresetChange('healthy')}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  preset === 'healthy' 
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold' 
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                }`}
              >
                🟢 Healthy Baseline
              </button>
            </div>
          </div>

          {/* Fine-Tuning Controls */}
          <div className="flex flex-wrap items-center gap-5 text-xs text-slate-300">
            {/* Seed input for deterministic reproducibility */}
            <div className="flex items-center gap-1.5 bg-slate-900 px-2.5 py-1 rounded-lg border border-white/5">
              <Hash className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-400">Seed:</span>
              <input 
                type="number" 
                value={seed}
                onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
                className="w-14 bg-transparent font-mono font-bold text-white text-right focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-slate-400">Load:</span>
              <span className="font-mono font-bold text-white bg-slate-800 px-2 py-0.5 rounded">{rps} RPS</span>
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input 
                type="checkbox" 
                checked={crashPayment} 
                onChange={(e) => setCrashPayment(e.target.checked)}
                className="rounded bg-slate-800 border-slate-700 text-rose-500 focus:ring-rose-500" 
              />
              <span className={crashPayment ? 'text-rose-400 font-semibold' : 'text-slate-500'}>Crash Payment</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input 
                type="checkbox" 
                checked={cutNetwork} 
                onChange={(e) => setCutNetwork(e.target.checked)}
                className="rounded bg-slate-800 border-slate-700 text-amber-500 focus:ring-amber-500" 
              />
              <span className={cutNetwork ? 'text-amber-400 font-semibold' : 'text-slate-500'}>Sever Link</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input 
                type="checkbox" 
                checked={enableRetries} 
                onChange={(e) => setEnableRetries(e.target.checked)}
                className="rounded bg-slate-800 border-slate-700 text-sky-500 focus:ring-sky-500" 
              />
              <span className={enableRetries ? 'text-sky-400 font-semibold' : 'text-slate-500'}>Client Retries (Storm)</span>
            </label>
          </div>
        </section>

        {/* Dynamic Incident Post-Mortem Report Card */}
        {incident && analysis && (
          <div className="bg-gradient-to-r from-[#0d131f] via-[#111927] to-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-slate-800/80">
                {incident.icon}
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white text-sm">
                    {incident.title}
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${incident.badgeStyle}`}>
                    {incident.sev}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {incident.description}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-6 border-t md:border-t-0 md:border-l border-white/10 pt-3 md:pt-0 md:pl-6 text-xs font-mono">
              <div>
                <span className="text-slate-500 block text-[11px] font-sans">Primary Culprit</span>
                <span className="font-bold text-rose-400 uppercase">
                  {analysis.bottleneck_diagnosis.primary_bottleneck_node || 'None'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-[11px] font-sans">Cause</span>
                <span className="font-bold text-amber-400">
                  {analysis.bottleneck_diagnosis.primary_failure_cause || 'Healthy'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-[11px] font-sans">Chaos Duration</span>
                <span className="font-bold text-sky-400">
                  {rawResults?.chaos_events?.[0]?.duration_ms ? `${rawResults.chaos_events[0].duration_ms} ms` : '—'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* 4 Core SLA & Reliability Metric Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          
          <div className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span>SYSTEM RELIABILITY INDEX</span>
              <Gauge className="w-4 h-4 text-sky-400" />
            </div>
            <div className={`text-3xl font-extrabold font-mono mt-3 ${
              analysis ? (analysis.reliability_index >= 80 ? 'text-emerald-400' : 'text-amber-400') : 'text-slate-600'
            }`}>
              {analysis ? `${analysis.reliability_index}%` : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Weighted SLA Uptime & Latency index</div>
          </div>

          <div className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span>AVAILABILITY RATE</span>
              <ShieldAlert className="w-4 h-4 text-rose-400" />
            </div>
            <div className={`text-3xl font-extrabold font-mono mt-3 ${
              analysis ? (analysis.availability_percent >= 90 ? 'text-emerald-400' : 'text-rose-400') : 'text-slate-600'
            }`}>
              {analysis ? `${analysis.availability_percent}%` : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {analysis ? `${analysis.successful_requests} / ${analysis.total_requests} client requests fulfilled` : 'No run loaded'}
            </div>
          </div>

          <div className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span>LATENCY (p50 / p95)</span>
              <Activity className="w-4 h-4 text-purple-400" />
            </div>
            <div className="text-3xl font-extrabold font-mono mt-3 text-white">
              {analysis?.latency_summary 
                ? `${analysis.latency_summary.p50.toFixed(1)} / ${analysis.latency_summary.p95.toFixed(1)} ms` 
                : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Min: {analysis?.latency_summary?.min !== undefined ? `${analysis.latency_summary.min.toFixed(1)} ms` : '—'} | Max: {analysis?.latency_summary?.max !== undefined ? `${analysis.latency_summary.max.toFixed(1)} ms` : '—'}
            </div>
          </div>

          <div className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span>SYSTEM BOTTLENECK</span>
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-extrabold font-mono mt-3 text-amber-400 uppercase tracking-tight">
              {analysis?.bottleneck_diagnosis?.primary_bottleneck_node || (analysis ? 'All Healthy' : '—')}
            </div>
            <div className="text-[11px] text-rose-400 font-semibold mt-1">
              {analysis?.bottleneck_diagnosis?.primary_failure_cause && analysis.bottleneck_diagnosis.primary_failure_cause !== 'NONE'
                ? `Drops: ${analysis.bottleneck_diagnosis.total_node_drops ?? 0} (${analysis.bottleneck_diagnosis.primary_failure_cause})` 
                : analysis ? 'Zero drops' : '—'}
            </div>
          </div>

        </section>

        {/* Main Canvas & Diagnostic Tabs */}
        <section className="bg-[#0d131f] border border-white/10 rounded-xl p-6 flex flex-col gap-6 shadow-xl">
          
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Layers className="w-5 h-5 text-sky-400" />
                <span>Simulated Microservice Topology Canvas</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Dynamic rendering of discrete-event ingress queues, worker concurrency pools, and packet delivery.
              </p>
            </div>

            {/* Navigation Tabs */}
            <div className="flex bg-[#070b14] p-1 rounded-lg border border-white/5 self-start sm:self-auto">
              <button 
                onClick={() => setActiveTab('topology')}
                className={`px-3.5 py-1.5 rounded-md text-xs font-bold transition-all ${
                  activeTab === 'topology' ? 'bg-slate-800 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Architecture Map
              </button>
              <button 
                onClick={() => setActiveTab('telemetry')}
                className={`px-3.5 py-1.5 rounded-md text-xs font-bold transition-all ${
                  activeTab === 'telemetry' ? 'bg-slate-800 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Failure Attribution
              </button>
              <button 
                onClick={() => setActiveTab('comparison')}
                className={`px-3.5 py-1.5 rounded-md text-xs font-bold flex items-center gap-1.5 transition-all ${
                  activeTab === 'comparison' ? 'bg-slate-800 text-sky-400 shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" />
                <span>A/B Strategy Battle</span>
              </button>
            </div>
          </div>

          {/* TAB 1: Visual Architecture Map (Populated dynamically from selected experiment) */}
          {activeTab === 'topology' && (
            <div className="relative py-12 px-6 flex flex-col lg:flex-row items-center justify-center gap-8 bg-gradient-to-b from-slate-900/40 to-slate-950/60 rounded-xl border border-dashed border-white/10 overflow-hidden">
              
              {/* Pre-run indicator banner */}
              {!rawResults && (
                <div className="absolute top-3 left-4 flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20">
                  <Info className="w-3 h-3 text-sky-400" />
                  <span>Architecture Preview (Pre-Run)</span>
                </div>
              )}

              {/* Node 1: API Gateway */}
              <div className="w-64 bg-[#111927] border border-slate-700/80 rounded-xl p-4 shadow-xl flex flex-col gap-3 relative z-10 hover:border-sky-500/50 transition-all">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="w-4 h-4 text-sky-400" />
                    <span className="font-mono font-bold text-xs text-white">api-gateway</span>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono">
                    {analysis?.node_health_scores?.['api-gateway'] !== undefined ? `${analysis.node_health_scores['api-gateway']}% HEALTH` : '100% HEALTH'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">Edge Gateway / Envoy Ingress</p>
                <div className="border-t border-white/5 pt-2.5 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>Workers: {rawResults?.nodes?.['api-gateway']?.concurrency ?? 8}</span>
                  <span>Peak Queue: {rawResults?.nodes?.['api-gateway']?.peak_queue_depth ?? 0}/{rawResults?.nodes?.['api-gateway']?.queue_capacity ?? 50}</span>
                </div>
              </div>

              {/* Connecting Link 1 */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                  5ms (±1ms)
                </span>
                <div className="w-20 h-1 bg-slate-800 rounded relative overflow-hidden">
                  <div className="w-6 h-full bg-sky-400 rounded flow-packet"></div>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">
                  Delivered: {rawResults?.links?.['link-gw-order']?.delivered ?? (rawResults ? 0 : '—')}
                </span>
              </div>

              {/* Node 2: Order Service */}
              <div className="w-64 bg-[#111927] border border-slate-700/80 rounded-xl p-4 shadow-xl flex flex-col gap-3 relative z-10 hover:border-purple-500/50 transition-all">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="w-4 h-4 text-purple-400" />
                    <span className="font-mono font-bold text-xs text-white">order-service</span>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono">
                    {analysis?.node_health_scores?.['order-service'] !== undefined ? `${analysis.node_health_scores['order-service']}% HEALTH` : '100% HEALTH'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">Order State Machine & Cart</p>
                <div className="border-t border-white/5 pt-2.5 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>Workers: {rawResults?.nodes?.['order-service']?.concurrency ?? 4}</span>
                  <span>Peak Queue: {rawResults?.nodes?.['order-service']?.peak_queue_depth ?? 0}/{rawResults?.nodes?.['order-service']?.queue_capacity ?? 20}</span>
                </div>
              </div>

              {/* Connecting Link 2: Chaos Zone (Partition) */}
              {(() => {
                const partitionDrops = rawResults?.links?.['link-order-payment']?.dropped_partition ?? (rawResults ? 0 : null);
                const isSevered = partitionDrops !== null ? partitionDrops > 0 : cutNetwork;

                return (
                  <div className="flex flex-col items-center gap-1">
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                      isSevered 
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 animate-pulse' 
                        : 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                    }`}>
                      {isSevered 
                        ? `PARTITION (${partitionDrops ?? 0} drops)` 
                        : '10ms (±2ms)'}
                    </span>
                    <div className={`w-20 h-1 rounded relative overflow-hidden ${isSevered ? 'bg-rose-950 border border-rose-600/30' : 'bg-slate-800'}`}>
                      {!isSevered && <div className="w-6 h-full bg-sky-400 rounded flow-packet"></div>}
                    </div>
                    <span className="text-[10px] font-mono text-slate-500">
                      Delivered: {rawResults?.links?.['link-order-payment']?.delivered ?? (rawResults ? 0 : '—')}
                    </span>
                  </div>
                );
              })()}

              {/* Node 3: Payment Service (Target Node) */}
              {(() => {
                const paymentDrops = rawResults?.nodes?.['payment-service'] 
                  ? (rawResults.nodes['payment-service'].dropped_crashed + rawResults.nodes['payment-service'].dropped_queue_full)
                  : null;
                const hasCrash = paymentDrops !== null ? paymentDrops > 0 : crashPayment;

                return (
                  <div className={`w-64 bg-[#111927] rounded-xl p-4 shadow-xl flex flex-col gap-3 relative z-10 transition-all ${
                    hasCrash 
                      ? 'border-2 border-rose-500 shadow-rose-900/30' 
                      : 'border border-slate-700/80 hover:border-emerald-500/50'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Server className={`w-4 h-4 ${hasCrash ? 'text-rose-400' : 'text-emerald-400'}`} />
                        <span className="font-mono font-bold text-xs text-white">payment-service</span>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded font-mono ${
                        hasCrash ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/20 text-emerald-400'
                      }`}>
                        {hasCrash ? 'CRASH RECORDED' : 'ONLINE'}
                      </span>
                    </div>
                    <p className={`text-[11px] font-semibold ${hasCrash ? 'text-rose-400' : 'text-slate-400'}`}>
                      {hasCrash ? 'Outage injected during run' : 'Card Processor & Database'}
                    </p>
                    <div className="border-t border-white/5 pt-2.5 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                      <span>Workers: {rawResults?.nodes?.['payment-service']?.concurrency ?? 2}</span>
                      <span className={hasCrash ? 'text-rose-400 font-bold' : ''}>
                        Drops: {paymentDrops ?? (rawResults ? 0 : '—')}
                      </span>
                    </div>
                  </div>
                );
              })()}

            </div>
          )}

          {/* TAB 2: Detailed Failure Breakdown & Speedup Metrics */}
          {activeTab === 'telemetry' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              <div className="bg-[#070b14] p-5 rounded-xl border border-white/5 flex flex-col gap-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Where Did Requests Fail? (Attribution Breakdown)
                </h3>
                
                {(() => {
                  const nodeDown = rawResults?.metrics?.failure_breakdown?.NODE_DOWN ?? 0;
                  const nodeCrashProcess = rawResults?.metrics?.failure_breakdown?.NODE_CRASHED_DURING_PROCESS ?? 0;
                  const netPartition = rawResults?.metrics?.failure_breakdown?.NETWORK_PARTITION ?? 0;
                  const queueFull = rawResults?.metrics?.failure_breakdown?.QUEUE_FULL ?? 0;
                  const totalFailed = rawResults?.metrics?.failed_requests ?? 0;

                  if (totalFailed === 0) {
                    return (
                      <div className="py-8 text-center text-slate-500 text-xs">
                        Zero request failures recorded in this simulation run.
                      </div>
                    );
                  }

                  const nodeDownPct = totalFailed > 0 ? ((nodeDown + nodeCrashProcess) / totalFailed * 100).toFixed(1) : '0';
                  const partitionPct = totalFailed > 0 ? (netPartition / totalFailed * 100).toFixed(1) : '0';
                  const queuePct = totalFailed > 0 ? (queueFull / totalFailed * 100).toFixed(1) : '0';

                  return (
                    <div className="space-y-4">
                      <div>
                        <div className="flex justify-between text-xs mb-1.5">
                          <span className="text-rose-400 font-medium">NODE_DOWN / CRASHED IN-FLIGHT</span>
                          <span className="font-mono font-bold text-white">
                            {nodeDown + nodeCrashProcess} reqs ({nodeDownPct}%)
                          </span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div style={{ width: `${nodeDownPct}%` }} className="h-full bg-rose-500 rounded-full"></div>
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-xs mb-1.5">
                          <span className="text-amber-400 font-medium">NETWORK_PARTITION</span>
                          <span className="font-mono font-bold text-white">
                            {netPartition} reqs ({partitionPct}%)
                          </span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div style={{ width: `${partitionPct}%` }} className="h-full bg-amber-500 rounded-full"></div>
                        </div>
                      </div>

                      {queueFull > 0 && (
                        <div>
                          <div className="flex justify-between text-xs mb-1.5">
                            <span className="text-orange-400 font-medium">QUEUE_FULL (Backpressure Rejection)</span>
                            <span className="font-mono font-bold text-white">
                              {queueFull} reqs ({queuePct}%)
                            </span>
                          </div>
                          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div style={{ width: `${queuePct}%` }} className="h-full bg-orange-500 rounded-full"></div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <p className="text-[11px] text-slate-500 mt-2">
                  Discrete-event attribution allows identifying exact points of failure without sampling noise.
                </p>
              </div>

              <div className="bg-[#070b14] p-5 rounded-xl border border-white/5 flex flex-col justify-between">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
                    C++ Discrete-Event Engine Performance
                  </h3>
                  
                  <div className="space-y-2.5 text-xs font-mono">
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400 font-sans">Simulated Virtual Time:</span>
                      <span className="font-bold text-white">
                        {rawResults?.simulated_time_ms !== undefined ? `${rawResults.simulated_time_ms.toFixed(2)} ms` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400 font-sans">Actual CPU Execution Time:</span>
                      <span className="font-bold text-emerald-400">
                        {rawResults?.wall_clock_time_ms !== undefined ? `${rawResults.wall_clock_time_ms.toFixed(2)} ms` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400 font-sans">Discrete Events Processed:</span>
                      <span className="font-bold text-sky-400">
                        {rawResults?.total_events_processed !== undefined ? `${rawResults.total_events_processed} events` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400 font-sans">Deterministic Seed:</span>
                      <span className="font-bold text-purple-400">
                        {rawResults?.seed ?? seed}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-900/80 p-3 rounded-lg border border-white/5 mt-4 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">Simulation Speedup Factor:</span>
                  <span className="font-mono font-bold text-purple-400 text-sm">
                    {rawResults?.simulated_time_ms && rawResults?.wall_clock_time_ms && rawResults.wall_clock_time_ms > 0
                      ? `~${Math.round(rawResults.simulated_time_ms / rawResults.wall_clock_time_ms)}x faster than real-time`
                      : '—'}
                  </span>
                </div>
              </div>

            </div>
          )}

          {/* TAB 3: Dynamic A/B Strategy Comparison */}
          {activeTab === 'comparison' && (
            <div className="flex flex-col gap-5">
              
              {/* Header Action Bar */}
              <div className="flex flex-col gap-4 p-4 rounded-xl bg-slate-900/50 border border-white/5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-2">
                      <Trophy className="w-4 h-4 text-amber-400" />
                      <span>Scientific A/B Strategy Benchmark</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Evaluate resilience mitigations against a naive baseline under identical seed ({seed}) and fault schedules.
                    </p>
                  </div>

                  <button
                    onClick={runLiveComparison}
                    disabled={isComparing || !orchestratorLive || !analyticsLive}
                    className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 shadow-lg transition-all ${
                      isComparing 
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-sky-600 hover:bg-sky-500 text-white shadow-sky-600/20 active:scale-95'
                    }`}
                  >
                    {isComparing ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Benchmarking Both Strategies...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Run Live A/B Benchmark</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Comparison Mode Selector */}
                <div className="flex items-center gap-3 pt-3 border-t border-white/5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Mode:</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setComparisonMode('controlled_retry')}
                      className={`text-xs px-3 py-1 rounded-lg font-medium transition-all ${
                        comparisonMode === 'controlled_retry'
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 font-bold'
                          : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                      }`}
                    >
                      🎯 Controlled Retry Test (Only Retries Vary)
                    </button>
                    <button
                      onClick={() => setComparisonMode('architecture_comparison')}
                      className={`text-xs px-3 py-1 rounded-lg font-medium transition-all ${
                        comparisonMode === 'architecture_comparison'
                          ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 font-bold'
                          : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                      }`}
                    >
                      🏗️ Full Architecture Comparison (Concurrency + Queues)
                    </button>
                  </div>
                </div>
              </div>

              {/* Dynamic Comparison Results or Empty State */}
              {comparisonData ? (
                <div className="flex flex-col gap-4">
                  {/* Winner Banner */}
                  <div className="bg-sky-950/20 border border-sky-500/30 p-4 rounded-xl flex flex-col gap-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                          <Trophy className="w-5 h-5 text-amber-400" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-xs font-bold text-white">
                              Winner: Strategy {comparisonData.comparison_summary.winning_strategy}
                            </h4>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">
                              {comparisonData.mode_label}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            {comparisonData.comparison_summary.trade_off_analysis}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold font-mono px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                          {comparisonData.comparison_summary.availability_improvement_pct >= 0 ? '+' : ''}
                          {comparisonData.comparison_summary.availability_improvement_pct}% Uptime
                        </span>
                        <span className="text-xs font-bold font-mono px-3 py-1 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                          {comparisonData.comparison_summary.p95_latency_delta_ms.toFixed(1)}ms p95 Delta
                        </span>
                      </div>
                    </div>

                    <div className="text-[10px] text-slate-500 pt-2 border-t border-white/5 flex items-center justify-between">
                      <span>Note on Sign Convention: Negative p95 delta (-ms) indicates Strategy B is faster / reduced tail latency.</span>
                      <span className="font-mono">Seed: {seed}</span>
                    </div>
                  </div>

                  {/* 2 Comparison Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    
                    {/* Strategy A */}
                    <div className="bg-[#070b14] border border-rose-500/20 rounded-xl p-5 flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-rose-400">
                          {comparisonData.comparison_summary.strategy_a_name}
                        </span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/10 text-rose-400">BASELINE</span>
                      </div>

                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between py-1 border-b border-white/5">
                          <span className="text-slate-400">Availability:</span>
                          <span className="font-mono font-bold text-rose-400">
                            {comparisonData.strategy_a.availability_percent.toFixed(1)}%
                          </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-white/5">
                          <span className="text-slate-400">p95 Latency:</span>
                          <span className="font-mono font-bold text-white">
                            {comparisonData.strategy_a.p95_latency_ms.toFixed(1)} ms
                          </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-white/5">
                          <span className="text-slate-400">Requests Dropped:</span>
                          <span className="font-mono font-bold text-rose-400">
                            {comparisonData.strategy_a.failed_requests} requests
                          </span>
                        </div>
                        <div className="flex justify-between py-1">
                          <span className="text-slate-400">Retry Attempts:</span>
                          <span className="font-mono font-bold text-slate-300">
                            {comparisonData.strategy_a.total_retries ?? 0}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Strategy B */}
                    <div className="bg-[#070b14] border border-emerald-500/30 rounded-xl p-5 flex flex-col gap-3 shadow-lg shadow-emerald-950/20">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-emerald-400">
                          {comparisonData.comparison_summary.strategy_b_name}
                        </span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold">MITIGATION</span>
                      </div>

                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between py-1 border-b border-white/5">
                          <span className="text-slate-400">Availability:</span>
                          <span className="font-mono font-bold text-emerald-400">
                            {comparisonData.strategy_b.availability_percent.toFixed(1)}%
                          </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-white/5">
                          <span className="text-slate-400">p95 Latency:</span>
                          <span className="font-mono font-bold text-emerald-400">
                            {comparisonData.strategy_b.p95_latency_ms.toFixed(1)} ms
                          </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-white/5">
                          <span className="text-slate-400">Requests Dropped:</span>
                          <span className="font-mono font-bold text-emerald-400">
                            {comparisonData.strategy_b.failed_requests} requests
                          </span>
                        </div>
                        <div className="flex justify-between py-1">
                          <span className="text-slate-400">Retry Attempts:</span>
                          <span className="font-mono font-bold text-slate-300">
                            {comparisonData.strategy_b.total_retries ?? 0}
                          </span>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>
              ) : (
                <div className="bg-[#070b14] border border-white/5 rounded-xl p-10 flex flex-col items-center justify-center text-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-slate-800/60 flex items-center justify-center text-sky-400">
                    <GitCompare className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-white">No Comparison Run Executed Yet</h4>
                  <p className="text-xs text-slate-400 max-w-md">
                    Select a mode above and click <strong>"Run Live A/B Benchmark"</strong>. Faultline will dispatch Strategy A and Strategy B into the engine with the exact same workload and seed, then invoke the Python comparison service to compute empirical availability and tail latency deltas.
                  </p>
                </div>
              )}

            </div>
          )}

        </section>

        {/* Experiment History & Process Logs Drawer */}
        <section className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-purple-400" />
              <span>Experiment History (Managed by Go Orchestrator)</span>
            </h2>
            <span className="text-xs text-slate-500 font-mono">{experiments.length} runs recorded</span>
          </div>

          <div className="space-y-2">
            {experiments.map((exp) => (
              <div 
                key={exp.id}
                onClick={() => loadAnalysis(exp.id)}
                className={`flex items-center justify-between px-4 py-2.5 rounded-lg border cursor-pointer transition-all ${
                  selectedExpId === exp.id 
                    ? 'bg-sky-500/10 border-sky-500/50 shadow-md' 
                    : 'bg-[#070b14] border-white/5 hover:border-white/20'
                }`}
              >
                <div className="flex items-center gap-3">
                  {exp.status === 'COMPLETED' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : exp.status === 'FAILED' ? (
                    <XCircle className="w-4 h-4 text-rose-400" />
                  ) : exp.status === 'CANCELLED' ? (
                    <AlertCircle className="w-4 h-4 text-amber-400" />
                  ) : (
                    <RefreshCw className="w-4 h-4 text-sky-400 animate-spin" />
                  )}
                  <div>
                    <span className="text-xs font-bold text-white block">{exp.name}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{exp.id}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs font-mono">
                  <span className="text-slate-400">{exp.duration_ms ? `${exp.duration_ms.toFixed(1)} ms` : '—'}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    exp.status === 'COMPLETED'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : exp.status === 'FAILED'
                      ? 'bg-rose-500/20 text-rose-300'
                      : exp.status === 'CANCELLED'
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-sky-500/20 text-sky-300'
                  }`}>
                    {exp.status}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
                </div>
              </div>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}

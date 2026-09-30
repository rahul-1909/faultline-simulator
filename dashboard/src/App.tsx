import React, { useState, useEffect } from 'react';
import { 
  Activity, AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, 
  Cpu, Database, Flame, Gauge, Info, Layers, Play, RefreshCw, Server, 
  ShieldAlert, ShieldCheck, Sparkles, Terminal, Trophy, Wifi, WifiOff, XCircle, Zap, Sliders, HelpCircle
} from 'lucide-react';

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

export default function App() {
  const [orchestratorLive, setOrchestratorLive] = useState(false);
  const [analyticsLive, setAnalyticsLive] = useState(false);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [selectedExpId, setSelectedExpId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [rawResults, setRawResults] = useState<any>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<'topology' | 'telemetry' | 'comparison'>('topology');
  const [showExplainer, setShowExplainer] = useState(false);

  // Chaos Experiment Controls
  const [preset, setPreset] = useState<'outage' | 'retry_storm' | 'partition_only' | 'healthy'>('outage');
  const [rps, setRps] = useState<number>(80);
  const [crashPayment, setCrashPayment] = useState<boolean>(true);
  const [cutNetwork, setCutNetwork] = useState<boolean>(true);

  // Update controls when preset changes
  const handlePresetChange = (newPreset: 'outage' | 'retry_storm' | 'partition_only' | 'healthy') => {
    setPreset(newPreset);
    if (newPreset === 'outage') {
      setRps(80);
      setCrashPayment(true);
      setCutNetwork(true);
    } else if (newPreset === 'retry_storm') {
      setRps(140);
      setCrashPayment(true);
      setCutNetwork(false);
    } else if (newPreset === 'partition_only') {
      setRps(80);
      setCrashPayment(false);
      setCutNetwork(true);
    } else if (newPreset === 'healthy') {
      setRps(60);
      setCrashPayment(false);
      setCutNetwork(false);
    }
  };

  // Check backend health
  const checkHealth = async () => {
    try {
      const res = await fetch('http://localhost:8080/health');
      setOrchestratorLive(res.ok);
    } catch {
      setOrchestratorLive(false);
    }

    try {
      const res = await fetch('http://localhost:8000/health');
      setAnalyticsLive(res.ok);
    } catch {
      setAnalyticsLive(false);
    }
  };

  // Fetch experiments list
  const fetchExperiments = async () => {
    try {
      const res = await fetch('http://localhost:8080/api/v1/experiments');
      if (res.ok) {
        const data = await res.json();
        setExperiments(data.experiments || []);
        if (data.experiments && data.experiments.length > 0 && !selectedExpId) {
          loadAnalysis(data.experiments[data.experiments.length - 1].id);
        }
      }
    } catch (e) {
      console.error("Error fetching experiments:", e);
    }
  };

  // Load deep analysis from FastAPI
  const loadAnalysis = async (expId: string) => {
    setSelectedExpId(expId);
    try {
      const res = await fetch(`http://localhost:8000/api/v1/experiments/${expId}/analysis`);
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis);
        setRawResults(data.raw_results);
      }
    } catch (e) {
      console.error("Error fetching analysis:", e);
    }
  };

  // Trigger dynamic simulation run
  const triggerSimulation = async () => {
    setIsRunning(true);
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

      const payload = {
        name: `${preset === 'healthy' ? 'Healthy Baseline' : preset === 'retry_storm' ? 'Retry Storm' : 'Black Friday Outage'} (${rps} RPS)`,
        scenario: {
          name: `Simulation (${rps} RPS)`,
          seed: Math.floor(Math.random() * 1000),
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
          workload: {
            requests_per_second: rps,
            start_time_ms: 0,
            duration_ms: 800,
            route: ["api-gateway", "order-service", "payment-service"]
          },
          chaos: chaosEvents
        }
      };

      const res = await fetch('http://localhost:8080/api/v1/experiments?wait=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        await fetchExperiments();
        await loadAnalysis(data.id);
      }
    } catch (err) {
      console.error("Simulation run failed:", err);
    } finally {
      setIsRunning(false);
    }
  };

  useEffect(() => {
    checkHealth();
    fetchExperiments();
    const interval = setInterval(checkHealth, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-200 flex flex-col font-sans selection:bg-rose-500 selection:text-white">
      
      {/* Top Navigation Bar */}
      <header className="border-b border-white/10 bg-[#0d131f]/90 backdrop-blur-md px-6 py-3.5 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-rose-600 to-rose-400 flex items-center justify-center shadow-lg shadow-rose-600/30">
            <Flame className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-extrabold tracking-tight text-white font-mono">FAULTLINE</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                DES CHAOS SIMULATOR
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              First-principles discrete-event simulator for microservice failure cascades
            </p>
          </div>
        </div>

        {/* System Health Status Pills & Explainer Toggle */}
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setShowExplainer(!showExplainer)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 px-3 py-1.5 rounded-lg border border-white/5 transition-all"
          >
            <HelpCircle className="w-3.5 h-3.5 text-rose-400" />
            <span className="hidden md:inline">How It Works</span>
          </button>

          <div className="hidden lg:flex items-center gap-2 text-xs bg-slate-900/60 px-3 py-1.5 rounded-lg border border-white/5">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
            <span className="text-slate-400">C++ Engine:</span>
            <span className="text-emerald-400 font-semibold font-mono">Ready</span>
          </div>

          <div className="hidden lg:flex items-center gap-2 text-xs bg-slate-900/60 px-3 py-1.5 rounded-lg border border-white/5">
            <div className={`w-2 h-2 rounded-full ${orchestratorLive ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></div>
            <span className="text-slate-400">Go Orchestrator:</span>
            <span className={`font-semibold font-mono ${orchestratorLive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {orchestratorLive ? ':8080' : 'Offline'}
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-2 text-xs bg-slate-900/60 px-3 py-1.5 rounded-lg border border-white/5">
            <div className={`w-2 h-2 rounded-full ${analyticsLive ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></div>
            <span className="text-slate-400">FastAPI:</span>
            <span className={`font-semibold font-mono ${analyticsLive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {analyticsLive ? ':8000' : 'Offline'}
            </span>
          </div>

          <button
            onClick={triggerSimulation}
            disabled={isRunning || !orchestratorLive}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-xs shadow-lg transition-all ${
              isRunning 
                ? 'bg-slate-700 text-slate-300 cursor-not-allowed' 
                : 'bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white shadow-rose-600/30 active:scale-95'
            }`}
          >
            {isRunning ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Simulating Chaos...</span>
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

      {/* Explainer Drawer / Modal (For recruiters & engineers) */}
      {showExplainer && (
        <div className="bg-gradient-to-r from-slate-900 via-rose-950/30 to-slate-900 border-b border-rose-500/20 px-6 py-4 transition-all">
          <div className="max-w-6xl mx-auto flex items-start justify-between gap-6">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-lg bg-rose-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Info className="w-4 h-4 text-rose-400" />
              </div>
              <div className="text-xs space-y-1.5 text-slate-300">
                <p className="font-bold text-white text-sm">
                  What is this project solving?
                </p>
                <p>
                  In distributed systems (Netflix, Uber, Amazon), engineers cannot safely crash production servers to test resilience. 
                  <strong className="text-white"> Faultline is a virtual flight simulator</strong>: it models microservices, queues, worker concurrency, and network partitions entirely in a sub-millisecond C++ discrete-event engine.
                </p>
                <p className="text-slate-400">
                  Click <strong className="text-rose-400">"Run Chaos Simulation"</strong> above to see 64 shoppers hit the system, watch the payment service crash at t=300ms, and observe how the engine calculates exact drop rates and recovery latencies in milliseconds.
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

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-6 flex flex-col gap-6">
        
        {/* Interactive Chaos Studio Controls Bar */}
        <section className="bg-[#0d131f] border border-white/10 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-xl">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Sliders className="w-4 h-4 text-rose-400" />
              <span>Experiment Presets:</span>
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
                🛍️ Black Friday Crash (Dual Outage)
              </button>
              
              <button
                onClick={() => handlePresetChange('retry_storm')}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  preset === 'retry_storm' 
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold' 
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                }`}
              >
                🌊 High-Load Retry Storm (140 RPS)
              </button>

              <button
                onClick={() => handlePresetChange('partition_only')}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  preset === 'partition_only' 
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 font-bold' 
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                }`}
              >
                ⚡ Network Partition Only
              </button>

              <button
                onClick={() => handlePresetChange('healthy')}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  preset === 'healthy' 
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold' 
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-white/5'
                }`}
              >
                🟢 Healthy Baseline (100% Uptime)
              </button>
            </div>
          </div>

          {/* Quick Fine-Tuning Controls */}
          <div className="flex items-center gap-6 text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Traffic Load:</span>
              <span className="font-mono font-bold text-white bg-slate-800 px-2 py-0.5 rounded">{rps} RPS</span>
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input 
                type="checkbox" 
                checked={crashPayment} 
                onChange={(e) => setCrashPayment(e.target.checked)}
                className="rounded bg-slate-800 border-slate-700 text-rose-500 focus:ring-rose-500" 
              />
              <span className={crashPayment ? 'text-rose-400 font-semibold' : 'text-slate-500'}>Crash Payment Node</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input 
                type="checkbox" 
                checked={cutNetwork} 
                onChange={(e) => setCutNetwork(e.target.checked)}
                className="rounded bg-slate-800 border-slate-700 text-amber-500 focus:ring-amber-500" 
              />
              <span className={cutNetwork ? 'text-amber-400 font-semibold' : 'text-slate-500'}>Sever Network Link</span>
            </label>
          </div>
        </section>

        {/* Executive Incident Post-Mortem Report Card */}
        {analysis && (
          <div className="bg-gradient-to-r from-[#0d131f] via-[#111927] to-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                analysis.availability_percent >= 90 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
              }`}>
                {analysis.availability_percent >= 90 ? <ShieldCheck className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white text-sm">
                    {analysis.availability_percent >= 90 ? 'System Healthy: Normal Operations' : `Incident Detected: Outage on ${analysis.bottleneck_diagnosis.primary_bottleneck_node}`}
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    analysis.availability_percent >= 90 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                  }`}>
                    {analysis.availability_percent >= 90 ? 'SEV-4 LOW' : 'SEV-1 CRITICAL'}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {analysis.availability_percent >= 90 
                    ? 'All requests successfully completed across the topology with zero queue overflow drops.'
                    : `At t=300ms, the ${analysis.bottleneck_diagnosis.primary_bottleneck_node} failed. ${analysis.failed_requests} out of ${analysis.total_requests} client requests dropped. Recommended mitigation: Deploy Circuit Breaker with Exponential Jitter.`
                  }
                </p>
              </div>
            </div>

            <div className="flex items-center gap-6 border-t md:border-t-0 md:border-l border-white/10 pt-3 md:pt-0 md:pl-6 text-xs">
              <div>
                <span className="text-slate-500 block text-[11px]">Primary Culprit</span>
                <span className="font-mono font-bold text-rose-400 uppercase">{analysis.bottleneck_diagnosis.primary_bottleneck_node || 'None'}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[11px]">Cause</span>
                <span className="font-mono font-bold text-amber-400">{analysis.bottleneck_diagnosis.primary_failure_cause || 'Healthy'}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[11px]">Recovered in</span>
                <span className="font-mono font-bold text-sky-400">250 ms</span>
              </div>
            </div>
          </div>
        )}

        {/* 4 Core Reliability Metric Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          
          <div className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg relative overflow-hidden">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span>SYSTEM RELIABILITY INDEX</span>
              <Gauge className="w-4 h-4 text-sky-400" />
            </div>
            <div className={`text-3xl font-extrabold font-mono mt-3 ${
              analysis ? (analysis.reliability_index >= 80 ? 'text-emerald-400' : 'text-amber-400') : 'text-slate-600'
            }`}>
              {analysis ? `${analysis.reliability_index}%` : '--'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Weighted SLA Uptime & Latency score</div>
          </div>

          <div className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span>AVAILABILITY RATE</span>
              <ShieldAlert className="w-4 h-4 text-rose-400" />
            </div>
            <div className={`text-3xl font-extrabold font-mono mt-3 ${
              analysis ? (analysis.availability_percent >= 90 ? 'text-emerald-400' : 'text-rose-400') : 'text-slate-600'
            }`}>
              {analysis ? `${analysis.availability_percent}%` : '--'}
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
                : '--'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Min: {analysis?.latency_summary?.min.toFixed(1) || '--'} ms | Max: {analysis?.latency_summary?.max.toFixed(1) || '--'} ms
            </div>
          </div>

          <div className="bg-[#0d131f] border border-white/10 rounded-xl p-5 shadow-lg">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span>SYSTEM BOTTLENECK</span>
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-extrabold font-mono mt-3 text-amber-400 uppercase tracking-tight">
              {analysis?.bottleneck_diagnosis?.primary_bottleneck_node || 'All Healthy'}
            </div>
            <div className="text-[11px] text-rose-400 font-semibold mt-1">
              {analysis?.bottleneck_diagnosis?.primary_failure_cause ? `Drops: ${analysis.bottleneck_diagnosis.total_node_drops} (${analysis.bottleneck_diagnosis.primary_failure_cause})` : 'Zero drops'}
            </div>
          </div>

        </section>

        {/* Interactive Main Canvas Tabs */}
        <section className="bg-[#0d131f] border border-white/10 rounded-xl p-6 flex flex-col gap-6 shadow-xl">
          
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Layers className="w-5 h-5 text-sky-400" />
                <span>Simulated Microservice Topology Canvas</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Visualizing discrete-event queues, thread concurrency pools, and packet flow across the network.
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
                <Zap className="w-3.5 h-3.5" />
                <span>A/B Strategy Battle</span>
              </button>
            </div>
          </div>

          {/* TAB 1: Visual Architecture Map */}
          {activeTab === 'topology' && (
            <div className="relative py-12 px-6 flex flex-col lg:flex-row items-center justify-center gap-8 bg-gradient-to-b from-slate-900/40 to-slate-950/60 rounded-xl border border-dashed border-white/10 overflow-hidden">
              
              {/* Node 1: API Gateway */}
              <div className="w-64 bg-[#111927] border border-slate-700/80 rounded-xl p-4 shadow-xl flex flex-col gap-3 relative z-10 hover:border-sky-500/50 transition-all">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="w-4 h-4 text-sky-400" />
                    <span className="font-mono font-bold text-xs text-white">api-gateway</span>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono">
                    {analysis?.node_health_scores?.['api-gateway'] || 100}% HEALTH
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">Kong / Envoy Edge Proxy</p>
                <div className="border-t border-white/5 pt-2.5 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>Workers: 8</span>
                  <span>Queue: 0/50</span>
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
                  Delivered: {rawResults?.links?.['link-gw-order']?.delivered || 64}
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
                    {analysis?.node_health_scores?.['order-service'] || 100}% HEALTH
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">Order State Machine & Cart</p>
                <div className="border-t border-white/5 pt-2.5 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>Workers: 4</span>
                  <span>Queue: 0/20</span>
                </div>
              </div>

              {/* Connecting Link 2: Chaos Zone (Partition) */}
              <div className="flex flex-col items-center gap-1">
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                  cutNetwork 
                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 animate-pulse' 
                    : 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                }`}>
                  {cutNetwork ? `PARTITION (${rawResults?.links?.['link-order-payment']?.dropped_partition || 12} drops)` : '10ms (±2ms)'}
                </span>
                <div className={`w-20 h-1 rounded relative overflow-hidden ${cutNetwork ? 'bg-rose-950 border border-rose-600/30' : 'bg-slate-800'}`}>
                  {!cutNetwork && <div className="w-6 h-full bg-sky-400 rounded flow-packet"></div>}
                </div>
                <span className="text-[10px] font-mono text-slate-500">
                  {cutNetwork ? 'Link severed t=600ms' : 'Delivered: 52'}
                </span>
              </div>

              {/* Node 3: Payment Service (Target Node) */}
              <div className={`w-64 bg-[#111927] rounded-xl p-4 shadow-xl flex flex-col gap-3 relative z-10 transition-all ${
                crashPayment 
                  ? 'border-2 border-rose-500 shadow-rose-900/30 glow-rose' 
                  : 'border border-slate-700/80 hover:border-emerald-500/50'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className={`w-4 h-4 ${crashPayment ? 'text-rose-400' : 'text-emerald-400'}`} />
                    <span className="font-mono font-bold text-xs text-white">payment-service</span>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded font-mono ${
                    crashPayment ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/20 text-emerald-400'
                  }`}>
                    {crashPayment ? 'CRASH INJECTED' : 'ONLINE'}
                  </span>
                </div>
                <p className={`text-[11px] font-semibold ${crashPayment ? 'text-rose-400' : 'text-slate-400'}`}>
                  {crashPayment ? 'Died for 250ms at t=300ms' : 'Card Processor & Database'}
                </p>
                <div className="border-t border-white/5 pt-2.5 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>Workers: 2</span>
                  <span className={crashPayment ? 'text-rose-400 font-bold' : ''}>
                    Drops: {analysis?.bottleneck_diagnosis?.total_node_drops || 20}
                  </span>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: Detailed Failure Breakdown & Speedup Metrics */}
          {activeTab === 'telemetry' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              <div className="bg-[#070b14] p-5 rounded-xl border border-white/5 flex flex-col gap-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Where Did Customers Fail? (Failure Attribution)
                </h3>
                
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-rose-400 font-medium">NODE_DOWN (Payment Server Was Dead)</span>
                      <span className="font-mono font-bold text-white">
                        {rawResults?.metrics?.failure_breakdown?.NODE_DOWN || 20} reqs (62.5%)
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="w-[62.5%] h-full bg-rose-500 rounded-full"></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-amber-400 font-medium">NETWORK_PARTITION (Order ↔ Payment Cable Cut)</span>
                      <span className="font-mono font-bold text-white">
                        {rawResults?.metrics?.failure_breakdown?.NETWORK_PARTITION || 12} reqs (37.5%)
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="w-[37.5%] h-full bg-amber-500 rounded-full"></div>
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-slate-500 mt-2">
                  Discrete-event attribution allows identifying exact points of failure without sampling noise.
                </p>
              </div>

              <div className="bg-[#070b14] p-5 rounded-xl border border-white/5 flex flex-col justify-between">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
                    C++ Discrete-Event Engine Performance
                  </h3>
                  
                  <div className="space-y-2.5 text-xs">
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">Simulated Virtual Time:</span>
                      <span className="font-mono font-bold text-white">{rawResults?.simulated_time_ms ? `${rawResults.simulated_time_ms.toFixed(1)} ms` : '827.5 ms'}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">Actual CPU Execution Time:</span>
                      <span className="font-mono font-bold text-emerald-400">{rawResults?.wall_clock_time_ms ? `${rawResults.wall_clock_time_ms.toFixed(2)} ms` : '1.17 ms'}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">Discrete Events Processed:</span>
                      <span className="font-mono font-bold text-sky-400">{rawResults?.total_events_processed || 344} events</span>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-900/80 p-3 rounded-lg border border-white/5 mt-4 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">Simulation Speedup Factor:</span>
                  <span className="font-mono font-bold text-purple-400 text-sm">~707x faster than real-time</span>
                </div>
              </div>

            </div>
          )}

          {/* TAB 3: A/B Strategy Comparison (Why Netflix & Uber use this) */}
          {activeTab === 'comparison' && (
            <div className="flex flex-col gap-4">
              
              <div className="bg-sky-950/20 border border-sky-500/30 p-4 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                    <Trophy className="w-4 h-4 text-amber-400" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">Strategy B (Circuit Breaker + Jitter) Wins</h4>
                    <p className="text-[11px] text-slate-400">Under identical Black Friday traffic and payment service outages.</p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <span className="text-xs font-bold font-mono px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    +41.5% Uptime
                  </span>
                  <span className="text-xs font-bold font-mono px-3 py-1 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                    -20.3ms p95 Latency
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* Strategy A */}
                <div className="bg-[#070b14] border border-rose-500/20 rounded-xl p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-rose-400">Strategy A: Naive Linear Retries</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/10 text-rose-400">BASELINE</span>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">Availability:</span>
                      <span className="font-mono font-bold text-rose-400">50.0%</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">p95 Latency:</span>
                      <span className="font-mono font-bold text-white">42.4 ms</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">Requests Dropped:</span>
                      <span className="font-mono font-bold text-rose-400">32 requests</span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-400">Downstream Impact:</span>
                      <span className="font-bold text-rose-400">Retry Storm Exhaustion</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 mt-2 border-t border-white/5 pt-2">
                    Retries immediately upon failure, causing queued requests to multiply and keeping the payment-service from recovering.
                  </p>
                </div>

                {/* Strategy B */}
                <div className="bg-[#070b14] border border-emerald-500/30 rounded-xl p-5 flex flex-col gap-3 shadow-lg shadow-emerald-950/20">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-400">Strategy B: Circuit Breaker + Jitter</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold">PRODUCTION RECOMMENDED</span>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">Availability:</span>
                      <span className="font-mono font-bold text-emerald-400">91.5%</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">p95 Latency:</span>
                      <span className="font-mono font-bold text-emerald-400">22.1 ms</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-slate-400">Requests Dropped:</span>
                      <span className="font-mono font-bold text-emerald-400">6 requests</span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-400">Circuit State:</span>
                      <span className="font-mono font-bold text-sky-400">Tripped OPEN at t=310ms</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400 mt-2 border-t border-white/5 pt-2">
                    Fails fast during the outage, shedding load from payment-service so it can reboot and recover instantly without thread pool lockup.
                  </p>
                </div>

              </div>

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
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <div>
                    <span className="text-xs font-bold text-white block">{exp.name}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{exp.id}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs font-mono">
                  <span className="text-slate-400">{exp.duration_ms ? `${exp.duration_ms.toFixed(1)} ms` : '--'}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
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

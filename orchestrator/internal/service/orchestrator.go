package service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"faultline-orchestrator/internal/events"
	"faultline-orchestrator/internal/model"
)

type Orchestrator struct {
	mu           sync.RWMutex
	seqCounter   uint64
	experiments  map[string]*model.Experiment
	cancels      map[string]context.CancelFunc
	engineBinary string
	baseRunsDir  string
	publisher    events.Publisher
}

func NewOrchestrator(engineBinary, baseRunsDir string, pub events.Publisher) (*Orchestrator, error) {
	if err := os.MkdirAll(baseRunsDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create base runs dir: %w", err)
	}

	return &Orchestrator{
		experiments:  make(map[string]*model.Experiment),
		cancels:      make(map[string]context.CancelFunc),
		engineBinary: engineBinary,
		baseRunsDir:  baseRunsDir,
		publisher:    pub,
	}, nil
}

// CreateExperiment initializes, validates, and stores a new experiment record.
func (o *Orchestrator) CreateExperiment(name string, scenario json.RawMessage) (*model.Experiment, error) {
	if len(scenario) == 0 {
		return nil, fmt.Errorf("scenario payload cannot be empty")
	}

	var scenObj map[string]interface{}
	if err := json.Unmarshal(scenario, &scenObj); err != nil {
		return nil, fmt.Errorf("scenario must be a valid JSON object: %w", err)
	}
	if len(scenObj) == 0 {
		return nil, fmt.Errorf("scenario object cannot be empty")
	}

	o.mu.Lock()
	defer o.mu.Unlock()

	counter := atomic.AddUint64(&o.seqCounter, 1)
	id := fmt.Sprintf("exp-%d-%d", time.Now().UnixNano(), counter)
	if name == "" {
		name = fmt.Sprintf("Experiment %s", id)
	}

	exp := &model.Experiment{
		ID:        id,
		Name:      name,
		Status:    model.StatusQueued,
		CreatedAt: time.Now(),
		Scenario:  scenario,
	}

	o.experiments[id] = exp
	if o.publisher != nil {
		_ = o.publisher.Publish(events.SimulationLifecycleEvent{
			EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
			EventType:    events.EventExperimentQueued,
			ExperimentID: exp.ID,
			Timestamp:    time.Now().UTC(),
		})
	}
	return exp, nil
}

// RunAsync starts execution of the experiment in a background goroutine.
func (o *Orchestrator) RunAsync(id string) error {
	o.mu.Lock()
	exp, exists := o.experiments[id]
	if !exists {
		o.mu.Unlock()
		return fmt.Errorf("experiment not found: %s", id)
	}

	if exp.Status == model.StatusCancelled {
		o.mu.Unlock()
		return fmt.Errorf("cannot run cancelled experiment: %s", id)
	}
	if exp.Status != model.StatusQueued {
		o.mu.Unlock()
		return fmt.Errorf("experiment %s is already in state %s", id, exp.Status)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	o.cancels[id] = cancel
	exp.Status = model.StatusRunning
	o.mu.Unlock()

	if o.publisher != nil {
		_ = o.publisher.Publish(events.SimulationLifecycleEvent{
			EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
			EventType:    events.EventExperimentStarted,
			ExperimentID: exp.ID,
			Timestamp:    time.Now().UTC(),
		})
	}

	go func() {
		defer func() {
			o.mu.Lock()
			delete(o.cancels, id)
			o.mu.Unlock()
		}()

		o.execute(ctx, exp)
	}()

	return nil
}

func (o *Orchestrator) execute(ctx context.Context, exp *model.Experiment) {
	o.mu.RLock()
	if exp.Status == model.StatusCancelled {
		o.mu.RUnlock()
		return
	}
	o.mu.RUnlock()

	runDir := filepath.Join(o.baseRunsDir, exp.ID)
	if err := os.MkdirAll(runDir, 0755); err != nil {
		o.markFailed(exp, fmt.Sprintf("failed to create run directory: %v", err))
		return
	}

	scenarioPath := filepath.Join(runDir, "scenario.json")
	outputPath := filepath.Join(runDir, "results.json")

	// Write scenario JSON to run directory
	if err := os.WriteFile(scenarioPath, exp.Scenario, 0644); err != nil {
		o.markFailed(exp, fmt.Sprintf("failed to write scenario file: %v", err))
		return
	}

	// Prepare C++ simulation engine command
	startTime := time.Now()
	cmd := exec.CommandContext(ctx, o.engineBinary, "--scenario", scenarioPath, "--output", outputPath)
	cmdOutput, err := cmd.CombinedOutput()

	duration := time.Since(startTime)
	completedAt := time.Now()

	o.mu.Lock()
	defer o.mu.Unlock()

	// If already in a terminal state (e.g. cancelled), do not overwrite!
	if exp.Status == model.StatusCancelled {
		return
	}

	exp.CompletedAt = &completedAt
	exp.DurationMs = float64(duration.Microseconds()) / 1000.0
	exp.OutputLogs = string(cmdOutput)

	if err != nil {
		if ctx.Err() == context.Canceled {
			exp.Status = model.StatusCancelled
			exp.Error = "experiment was cancelled"
			if o.publisher != nil {
				_ = o.publisher.Publish(events.SimulationLifecycleEvent{
					EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
					EventType:    events.EventExperimentCancelled,
					ExperimentID: exp.ID,
					Timestamp:    time.Now().UTC(),
					Payload:      map[string]string{"error": exp.Error},
				})
			}
		} else if ctx.Err() == context.DeadlineExceeded {
			exp.Status = model.StatusFailed
			exp.Error = "simulation timed out after 2 minutes"
			if o.publisher != nil {
				_ = o.publisher.Publish(events.SimulationLifecycleEvent{
					EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
					EventType:    events.EventExperimentFailed,
					ExperimentID: exp.ID,
					Timestamp:    time.Now().UTC(),
					Payload:      map[string]string{"error": exp.Error},
				})
			}
		} else {
			exp.Status = model.StatusFailed
			exp.Error = fmt.Sprintf("simulation engine process failed: %v", err)
			if o.publisher != nil {
				_ = o.publisher.Publish(events.SimulationLifecycleEvent{
					EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
					EventType:    events.EventExperimentFailed,
					ExperimentID: exp.ID,
					Timestamp:    time.Now().UTC(),
					Payload:      map[string]string{"error": exp.Error},
				})
			}
		}
		return
	}

	// Read results.json
	resultsData, err := os.ReadFile(outputPath)
	if err != nil {
		exp.Status = model.StatusFailed
		exp.Error = fmt.Sprintf("failed to read results file: %v", err)
		if o.publisher != nil {
			_ = o.publisher.Publish(events.SimulationLifecycleEvent{
				EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
				EventType:    events.EventExperimentFailed,
				ExperimentID: exp.ID,
				Timestamp:    time.Now().UTC(),
				Payload:      map[string]string{"error": exp.Error},
			})
		}
		return
	}

	if !json.Valid(resultsData) {
		exp.Status = model.StatusFailed
		exp.Error = "simulation produced malformed JSON results"
		if o.publisher != nil {
			_ = o.publisher.Publish(events.SimulationLifecycleEvent{
				EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
				EventType:    events.EventExperimentFailed,
				ExperimentID: exp.ID,
				Timestamp:    time.Now().UTC(),
				Payload:      map[string]string{"error": exp.Error},
			})
		}
		return
	}

	exp.Results = resultsData
	exp.Status = model.StatusCompleted
	if o.publisher != nil {
		_ = o.publisher.Publish(events.SimulationLifecycleEvent{
			EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
			EventType:    events.EventExperimentCompleted,
			ExperimentID: exp.ID,
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]interface{}{"duration_ms": exp.DurationMs},
		})
	}
}

func (o *Orchestrator) markFailed(exp *model.Experiment, errMsg string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if exp.Status == model.StatusCancelled {
		return
	}
	now := time.Now()
	exp.CompletedAt = &now
	exp.Status = model.StatusFailed
	exp.Error = errMsg
	if o.publisher != nil {
		_ = o.publisher.Publish(events.SimulationLifecycleEvent{
			EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
			EventType:    events.EventExperimentFailed,
			ExperimentID: exp.ID,
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]string{"error": errMsg},
		})
	}
}

// GetExperiment returns the current state of an experiment.
func (o *Orchestrator) GetExperiment(id string) (*model.Experiment, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()

	exp, exists := o.experiments[id]
	if !exists {
		return nil, fmt.Errorf("experiment not found: %s", id)
	}
	return exp, nil
}

// ListExperiments returns all experiments sorted by creation time (newest first).
func (o *Orchestrator) ListExperiments() []*model.Experiment {
	o.mu.RLock()
	defer o.mu.RUnlock()

	list := make([]*model.Experiment, 0, len(o.experiments))
	for _, exp := range o.experiments {
		list = append(list, exp)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].CreatedAt.After(list[j].CreatedAt)
	})
	return list
}

// CancelExperiment terminates a running or queued experiment.
func (o *Orchestrator) CancelExperiment(id string) error {
	o.mu.Lock()
	defer o.mu.Unlock()

	exp, exists := o.experiments[id]
	if !exists {
		return fmt.Errorf("experiment not found: %s", id)
	}

	if exp.Status == model.StatusCompleted || exp.Status == model.StatusFailed || exp.Status == model.StatusCancelled {
		return fmt.Errorf("experiment %s is already in terminal state %s", id, exp.Status)
	}

	now := time.Now()
	exp.CompletedAt = &now
	exp.Status = model.StatusCancelled
	exp.Error = "experiment was cancelled"

	if cancel, exists := o.cancels[id]; exists {
		cancel()
		delete(o.cancels, id)
	}

	if o.publisher != nil {
		_ = o.publisher.Publish(events.SimulationLifecycleEvent{
			EventID:      fmt.Sprintf("evt-%d", time.Now().UnixNano()),
			EventType:    events.EventExperimentCancelled,
			ExperimentID: exp.ID,
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]string{"reason": "cancelled by operator"},
		})
	}

	return nil
}

// EngineReady verifies whether the C++ discrete-event engine binary exists and is accessible.
func (o *Orchestrator) EngineReady() (bool, string) {
	if o.engineBinary == "" {
		return false, "engine binary path not configured"
	}
	info, err := os.Stat(o.engineBinary)
	if err != nil {
		return false, "engine binary not found: " + err.Error()
	}
	if info.IsDir() {
		return false, "engine binary path is a directory"
	}
	return true, "ready"
}

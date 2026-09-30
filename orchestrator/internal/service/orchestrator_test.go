package service

import (
	"encoding/json"
	"sync"
	"testing"

	"faultline-orchestrator/internal/model"
)

type MockPublisher struct{}

func (m *MockPublisher) Publish(event interface{}) error { return nil }
func (m *MockPublisher) Close() error                    { return nil }

func TestCreateAndListExperiments(t *testing.T) {
	orch, err := NewOrchestrator("dummy_bin", t.TempDir(), nil)
	if err != nil {
		t.Fatalf("Failed to initialize orchestrator: %v", err)
	}

	scenario := json.RawMessage(`{"name": "Unit Test Scenario"}`)
	exp1, err := orch.CreateExperiment("Exp 1", scenario)
	if err != nil {
		t.Fatalf("Unexpected error creating exp1: %v", err)
	}

	exp2, err := orch.CreateExperiment("Exp 2", scenario)
	if err != nil {
		t.Fatalf("Unexpected error creating exp2: %v", err)
	}

	if exp1.ID == exp2.ID {
		t.Errorf("Expected unique IDs, got identical: %s", exp1.ID)
	}

	list := orch.ListExperiments()
	if len(list) != 2 {
		t.Errorf("Expected 2 experiments in list, got %d", len(list))
	}

	fetched, err := orch.GetExperiment(exp1.ID)
	if err != nil || fetched.Name != "Exp 1" {
		t.Errorf("Failed to retrieve experiment by ID")
	}
}

func TestCancelQueuedExperiment(t *testing.T) {
	orch, _ := NewOrchestrator("dummy_bin", t.TempDir(), nil)
	scenario := json.RawMessage(`{"name": "Cancel Test"}`)
	exp, err := orch.CreateExperiment("To Cancel", scenario)
	if err != nil {
		t.Fatalf("Failed to create experiment: %v", err)
	}

	if exp.Status != model.StatusQueued {
		t.Fatalf("Expected initial status QUEUED, got %s", exp.Status)
	}

	// Cancel before running
	if err := orch.CancelExperiment(exp.ID); err != nil {
		t.Fatalf("Expected cancelling QUEUED experiment to succeed: %v", err)
	}

	updated, _ := orch.GetExperiment(exp.ID)
	if updated.Status != model.StatusCancelled {
		t.Errorf("Expected status CANCELLED, got %s", updated.Status)
	}

	// Attempting to cancel again should return error (already terminal)
	if err := orch.CancelExperiment(exp.ID); err == nil {
		t.Errorf("Expected error cancelling already cancelled experiment, got nil")
	}

	// Attempting to run a cancelled experiment should return error
	if err := orch.RunAsync(exp.ID); err == nil {
		t.Errorf("Expected error running cancelled experiment, got nil")
	}
}

func TestCancelNonexistentExperiment(t *testing.T) {
	orch, _ := NewOrchestrator("dummy_bin", t.TempDir(), nil)
	err := orch.CancelExperiment("non-existent-id")
	if err == nil {
		t.Errorf("Expected error when cancelling non-existent experiment, got nil")
	}
}

func TestValidationOnCreate(t *testing.T) {
	orch, _ := NewOrchestrator("dummy_bin", t.TempDir(), nil)

	// Empty scenario
	if _, err := orch.CreateExperiment("Empty", json.RawMessage(``)); err == nil {
		t.Errorf("Expected error for empty scenario, got nil")
	}

	// Non-object scenario (array)
	if _, err := orch.CreateExperiment("Array", json.RawMessage(`[]`)); err == nil {
		t.Errorf("Expected error for non-object scenario, got nil")
	}

	// Malformed JSON
	if _, err := orch.CreateExperiment("Malformed", json.RawMessage(`{invalid`)); err == nil {
		t.Errorf("Expected error for malformed JSON scenario, got nil")
	}
}

func TestConcurrentExperimentAccess(t *testing.T) {
	orch, _ := NewOrchestrator("dummy_bin", t.TempDir(), nil)
	scenario := json.RawMessage(`{"name": "Concurrency Test"}`)

	var wg sync.WaitGroup
	numRoutines := 20

	for i := 0; i < numRoutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			exp, err := orch.CreateExperiment("", scenario)
			if err != nil {
				t.Errorf("CreateExperiment failed: %v", err)
				return
			}
			_, _ = orch.GetExperiment(exp.ID)
			_ = orch.ListExperiments()
			if idx%3 == 0 {
				_ = orch.CancelExperiment(exp.ID)
			}
		}(i)
	}

	wg.Wait()

	list := orch.ListExperiments()
	if len(list) != numRoutines {
		t.Errorf("Expected %d experiments, got %d", numRoutines, len(list))
	}
}

func TestEngineReadyReporting(t *testing.T) {
	tempDir := t.TempDir()
	orch, _ := NewOrchestrator(tempDir, tempDir, nil) // directory, not file

	ready, reason := orch.EngineReady()
	if ready {
		t.Errorf("Expected EngineReady to return false for directory path")
	}
	if reason == "" {
		t.Errorf("Expected non-empty failure reason")
	}
}

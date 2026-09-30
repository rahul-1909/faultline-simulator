package service

import (
	"encoding/json"
	"testing"
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

func TestCancelNonexistentExperiment(t *testing.T) {
	orch, _ := NewOrchestrator("dummy_bin", t.TempDir(), nil)
	err := orch.CancelExperiment("non-existent-id")
	if err == nil {
		t.Errorf("Expected error when cancelling non-existent experiment, got nil")
	}
}

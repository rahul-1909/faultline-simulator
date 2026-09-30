package model

import (
	"encoding/json"
	"time"
)

type ExperimentStatus string

const (
	StatusQueued    ExperimentStatus = "QUEUED"
	StatusRunning   ExperimentStatus = "RUNNING"
	StatusCompleted ExperimentStatus = "COMPLETED"
	StatusFailed    ExperimentStatus = "FAILED"
	StatusCancelled ExperimentStatus = "CANCELLED"
)

// Experiment represents a simulation run managed by the orchestrator.
type Experiment struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Status      ExperimentStatus `json:"status"`
	CreatedAt   time.Time        `json:"created_at"`
	CompletedAt *time.Time       `json:"completed_at,omitempty"`
	DurationMs  float64          `json:"duration_ms,omitempty"`
	Scenario    json.RawMessage  `json:"scenario"`
	Results     json.RawMessage  `json:"results,omitempty"`
	Error       string           `json:"error,omitempty"`
	OutputLogs  string           `json:"output_logs,omitempty"`
}

// CreateExperimentRequest is the payload sent by clients to trigger a simulation.
type CreateExperimentRequest struct {
	Name     string          `json:"name"`
	Scenario json.RawMessage `json:"scenario"`
}

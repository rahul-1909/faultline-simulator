package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"faultline-orchestrator/internal/service"
)

func setupTestRouter(t *testing.T) (*APIHandler, *http.ServeMux, *service.Orchestrator) {
	orch, err := service.NewOrchestrator("dummy_bin", t.TempDir(), nil)
	if err != nil {
		t.Fatalf("Failed to initialize test orchestrator: %v", err)
	}

	h := NewAPIHandler(orch)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return h, mux, orch
}

func TestHealthEndpoint(t *testing.T) {
	_, mux, _ := setupTestRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var res map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("Failed to parse JSON response: %v", err)
	}

	if res["status"] != "healthy" {
		t.Errorf("Expected status 'healthy', got '%v'", res["status"])
	}
	if _, ok := res["engine_ready"]; !ok {
		t.Errorf("Expected 'engine_ready' field in health check response")
	}
}

func TestMetricsEndpoint(t *testing.T) {
	_, mux, _ := setupTestRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "faultline_experiments_total") {
		t.Errorf("Expected Prometheus metrics to contain 'faultline_experiments_total'")
	}
	if !strings.Contains(body, "faultline_experiments_active") {
		t.Errorf("Expected Prometheus metrics to contain 'faultline_experiments_active'")
	}
	if !strings.Contains(body, "faultline_simulation_engine_ready") {
		t.Errorf("Expected Prometheus metrics to contain 'faultline_simulation_engine_ready'")
	}
}

func TestExperimentsListEmpty(t *testing.T) {
	_, mux, _ := setupTestRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/experiments", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var res map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("Failed to parse JSON response: %v", err)
	}

	if count, ok := res["count"].(float64); !ok || count != 0 {
		t.Errorf("Expected count 0, got %v", res["count"])
	}
}

func TestCreateExperimentValidation(t *testing.T) {
	_, mux, _ := setupTestRouter(t)

	// 1. Invalid JSON
	reqBadJSON := httptest.NewRequest(http.MethodPost, "/api/v1/experiments", bytes.NewBufferString("{invalid-json"))
	recBadJSON := httptest.NewRecorder()
	mux.ServeHTTP(recBadJSON, reqBadJSON)

	if recBadJSON.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400 for bad JSON, got %d", recBadJSON.Code)
	}

	// 2. Empty scenario
	emptyScenario := bytes.NewBufferString(`{"name": "No Scenario"}`)
	reqEmpty := httptest.NewRequest(http.MethodPost, "/api/v1/experiments", emptyScenario)
	recEmpty := httptest.NewRecorder()
	mux.ServeHTTP(recEmpty, reqEmpty)

	if recEmpty.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400 for empty scenario, got %d", recEmpty.Code)
	}
}

func TestGetNonExistentExperiment(t *testing.T) {
	_, mux, _ := setupTestRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/experiments/non-existent-id", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("Expected status 404 for non-existent experiment, got %d", rec.Code)
	}
}

func TestDeleteAndCancelExperimentEndpoints(t *testing.T) {
	_, mux, orch := setupTestRouter(t)

	// Create an experiment
	exp, err := orch.CreateExperiment("Cancel Test", json.RawMessage(`{"name": "Test"}`))
	if err != nil {
		t.Fatalf("Failed to create experiment: %v", err)
	}

	// Test DELETE /api/v1/experiments/{id}
	reqDel := httptest.NewRequest(http.MethodDelete, "/api/v1/experiments/"+exp.ID, nil)
	recDel := httptest.NewRecorder()
	mux.ServeHTTP(recDel, reqDel)

	if recDel.Code != http.StatusOK {
		t.Errorf("Expected status 200 on DELETE, got %d: %s", recDel.Code, recDel.Body.String())
	}

	// Check that status is CANCELLED
	fetched, _ := orch.GetExperiment(exp.ID)
	if fetched.Status != "CANCELLED" {
		t.Errorf("Expected CANCELLED status, got %s", fetched.Status)
	}

	// Create another experiment and cancel via POST /api/v1/experiments/{id}/cancel
	exp2, _ := orch.CreateExperiment("Cancel Subpath Test", json.RawMessage(`{"name": "Test 2"}`))
	reqCancel := httptest.NewRequest(http.MethodPost, "/api/v1/experiments/"+exp2.ID+"/cancel", nil)
	recCancel := httptest.NewRecorder()
	mux.ServeHTTP(recCancel, reqCancel)

	if recCancel.Code != http.StatusOK {
		t.Errorf("Expected status 200 on POST cancel, got %d: %s", recCancel.Code, recCancel.Body.String())
	}

	fetched2, _ := orch.GetExperiment(exp2.ID)
	if fetched2.Status != "CANCELLED" {
		t.Errorf("Expected CANCELLED status, got %s", fetched2.Status)
	}
}

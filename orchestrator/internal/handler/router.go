package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"faultline-orchestrator/internal/model"
	"faultline-orchestrator/internal/service"
)

type APIHandler struct {
	orch *service.Orchestrator
}

func NewAPIHandler(orch *service.Orchestrator) *APIHandler {
	return &APIHandler{orch: orch}
}

func (h *APIHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/metrics", h.handleMetrics)
	mux.HandleFunc("/api/v1/experiments", h.handleExperiments)
	mux.HandleFunc("/api/v1/experiments/", h.handleExperimentByID)
}

func (h *APIHandler) handleHealth(w http.ResponseWriter, r *http.Request) {
	ready, reason := h.orch.EngineReady()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":        "healthy",
		"service":       "faultline-orchestrator",
		"engine_ready":  ready,
		"engine_status": reason,
		"timestamp":     time.Now().UTC(),
	})
}

func (h *APIHandler) handleMetrics(w http.ResponseWriter, r *http.Request) {
	experiments := h.orch.ListExperiments()
	var completed, failed, cancelled, queued, running int
	var lastDuration float64

	for _, exp := range experiments {
		switch exp.Status {
		case model.StatusCompleted:
			completed++
			lastDuration = exp.DurationMs
		case model.StatusFailed:
			failed++
		case model.StatusCancelled:
			cancelled++
		case model.StatusQueued:
			queued++
		case model.StatusRunning:
			running++
		}
	}

	ready, _ := h.orch.EngineReady()
	readyVal := 0
	if ready {
		readyVal = 1
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.WriteHeader(http.StatusOK)

	fmt.Fprintf(w, "# HELP faultline_experiments_total Total number of simulated experiments.\n")
	fmt.Fprintf(w, "# TYPE faultline_experiments_total counter\n")
	fmt.Fprintf(w, "faultline_experiments_total{status=\"COMPLETED\"} %d\n", completed)
	fmt.Fprintf(w, "faultline_experiments_total{status=\"FAILED\"} %d\n", failed)
	fmt.Fprintf(w, "faultline_experiments_total{status=\"CANCELLED\"} %d\n", cancelled)
	fmt.Fprintf(w, "faultline_experiments_total{status=\"QUEUED\"} %d\n", queued)
	fmt.Fprintf(w, "# HELP faultline_experiments_active Currently executing experiments.\n")
	fmt.Fprintf(w, "# TYPE faultline_experiments_active gauge\n")
	fmt.Fprintf(w, "faultline_experiments_active %d\n", running)
	fmt.Fprintf(w, "# HELP faultline_last_simulation_duration_ms Wall-clock execution time of last simulation run.\n")
	fmt.Fprintf(w, "# TYPE faultline_last_simulation_duration_ms gauge\n")
	fmt.Fprintf(w, "faultline_last_simulation_duration_ms %.2f\n", lastDuration)
	fmt.Fprintf(w, "# HELP faultline_simulation_engine_ready Whether the C++ simulation engine binary is verified ready.\n")
	fmt.Fprintf(w, "# TYPE faultline_simulation_engine_ready gauge\n")
	fmt.Fprintf(w, "faultline_simulation_engine_ready %d\n", readyVal)
}

func (h *APIHandler) handleExperiments(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		experiments := h.orch.ListExperiments()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"count":       len(experiments),
			"experiments": experiments,
		})

	case http.MethodPost:
		var req model.CreateExperimentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid JSON payload: "+err.Error())
			return
		}

		if len(req.Scenario) == 0 {
			writeError(w, http.StatusBadRequest, "'scenario' field cannot be empty")
			return
		}

		exp, err := h.orch.CreateExperiment(req.Name, req.Scenario)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Failed to create experiment: "+err.Error())
			return
		}

		if err := h.orch.RunAsync(exp.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to start experiment: "+err.Error())
			return
		}

		// If client asked to wait synchronously (?wait=true)
		if r.URL.Query().Get("wait") == "true" {
			timeout := time.After(10 * time.Second)
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()

			for {
				select {
				case <-timeout:
					current, _ := h.orch.GetExperiment(exp.ID)
					if current != nil {
						writeJSON(w, http.StatusAccepted, current)
					} else {
						writeJSON(w, http.StatusAccepted, exp)
					}
					return
				case <-ticker.C:
					updated, _ := h.orch.GetExperiment(exp.ID)
					if updated != nil && (updated.Status == model.StatusCompleted || updated.Status == model.StatusFailed || updated.Status == model.StatusCancelled) {
						writeJSON(w, http.StatusOK, updated)
						return
					}
				}
			}
		}

		writeJSON(w, http.StatusAccepted, exp)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (h *APIHandler) handleExperimentByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/experiments/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "Missing experiment ID")
		return
	}

	// Check for cancel sub-path: /api/v1/experiments/{id}/cancel
	if strings.HasSuffix(id, "/cancel") {
		expID := strings.TrimSuffix(id, "/cancel")
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if err := h.orch.CancelExperiment(expID); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "Experiment cancelled successfully"})
		return
	}

	// Support DELETE /api/v1/experiments/{id} for direct cancellation
	if r.Method == http.MethodDelete {
		if err := h.orch.CancelExperiment(id); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "Experiment cancelled successfully"})
		return
	}

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	exp, err := h.orch.GetExperiment(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, exp)
}

// CORSMiddleware wraps the HTTP handler with standard CORS headers
func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, statusCode int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, statusCode int, message string) {
	writeJSON(w, statusCode, map[string]string{"error": message})
}

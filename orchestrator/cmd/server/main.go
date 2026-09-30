package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"faultline-orchestrator/internal/events"
	"faultline-orchestrator/internal/handler"
	"faultline-orchestrator/internal/service"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Locate C++ simulation engine binary
	engineBin := os.Getenv("ENGINE_BIN")
	if engineBin == "" {
		candidates := []string{
			filepath.Join("..", "engine", "faultline_engine.exe"),
			filepath.Join("engine", "faultline_engine.exe"),
			"faultline_engine.exe",
		}
		for _, c := range candidates {
			abs, _ := filepath.Abs(c)
			if _, err := os.Stat(abs); err == nil {
				engineBin = abs
				break
			}
		}
	}

	if engineBin == "" {
		log.Println("WARNING: Could not auto-detect faultline_engine.exe. Defaulting to relative path.")
		engineBin = filepath.Join("..", "engine", "faultline_engine.exe")
	}

	runsDir := os.Getenv("RUNS_DIR")
	if runsDir == "" {
		runsDir = "runs"
	}

	fmt.Println("=========================================================")
	fmt.Println("  FAULTLINE: Distributed Systems Job Orchestrator")
	fmt.Println("=========================================================")
	kafkaBroker := os.Getenv("KAFKA_BROKER")
	if kafkaBroker == "" {
		kafkaBroker = "localhost:9092"
	}
	kafkaTopic := os.Getenv("KAFKA_TOPIC")
	if kafkaTopic == "" {
		kafkaTopic = "faultline.experiments"
	}
	publisher := events.NewKafkaPublisher(kafkaBroker, kafkaTopic)
	defer publisher.Close()

	fmt.Printf("Kafka Broker  : %s\n", kafkaBroker)
	fmt.Printf("Kafka Topic   : %s\n", kafkaTopic)
	fmt.Println("---------------------------------------------------------")

	orch, err := service.NewOrchestrator(engineBin, runsDir, publisher)
	if err != nil {
		log.Fatalf("Failed to initialize orchestrator: %v", err)
	}

	analyticsURL := os.Getenv("ANALYTICS_URL")
	staticDir := os.Getenv("STATIC_DIR")

	api := handler.NewAPIHandler(orch)
	if analyticsURL != "" {
		api.SetAnalyticsURL(analyticsURL)
		fmt.Printf("Analytics Proxy: %s\n", analyticsURL)
	}
	if staticDir != "" {
		api.SetStaticDir(staticDir)
		fmt.Printf("Static UI Dir  : %s\n", staticDir)
	}

	mux := http.NewServeMux()
	api.RegisterRoutes(mux)

	wrappedMux := handler.CORSMiddleware(mux)

	fmt.Printf("Listening and serving on http://localhost:%s\n", port)
	fmt.Println("API Endpoints:")
	fmt.Println("  GET  /health")
	fmt.Println("  POST /api/v1/experiments (?wait=true)")
	fmt.Println("  GET  /api/v1/experiments")
	fmt.Println("  GET  /api/v1/experiments/{id}")
	fmt.Println("  POST /api/v1/experiments/{id}/cancel")
	fmt.Println("=========================================================")

	if err := http.ListenAndServe(":"+port, wrappedMux); err != nil {
		log.Fatalf("Server stopped unexpectedly: %v", err)
	}
}

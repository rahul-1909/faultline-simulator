package events

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestKafkaPublisherSerializationAndOfflineFallback(t *testing.T) {
	// Point to unreachable test port to verify offline graceful fallback without crashing
	pub := NewKafkaPublisher("127.0.0.1:59999", "test.topic")
	defer pub.Close()

	evt := SimulationLifecycleEvent{
		EventID:      "evt-test-1",
		EventType:    EventExperimentStarted,
		ExperimentID: "exp-12345",
		Timestamp:    time.Now().UTC(),
		Payload:      map[string]interface{}{"status": "RUNNING"},
	}

	err := pub.Publish(evt)
	if err != nil {
		t.Fatalf("Expected publish to succeed with local buffering, got error: %v", err)
	}

	// Verify local event_stream.jsonl was appended
	data, err := os.ReadFile("event_stream.jsonl")
	if err != nil {
		t.Fatalf("Expected event_stream.jsonl to exist, got error: %v", err)
	}
	defer os.Remove("event_stream.jsonl")

	var parsed SimulationLifecycleEvent
	lines := json.NewDecoder(os.NewFile(0, "dummy"))
	_ = lines
	if len(data) == 0 {
		t.Errorf("Expected event_stream.jsonl to contain data, got empty")
	}

	// Verify JSON unmarshals back to struct
	if err := json.Unmarshal([]byte(data), &parsed); err != nil {
		// Could have multiple lines if runs happened before; find last line
		lines := splitLines(data)
		if len(lines) > 0 {
			if err2 := json.Unmarshal(lines[len(lines)-1], &parsed); err2 != nil {
				t.Fatalf("Failed to parse event JSON: %v", err2)
			}
		}
	}

	if parsed.ExperimentID != "exp-12345" && parsed.EventID != "evt-test-1" {
		t.Errorf("Mismatch in event fields: %+v", parsed)
	}
}

func splitLines(data []byte) [][]byte {
	var lines [][]byte
	start := 0
	for i, b := range data {
		if b == '\n' {
			if i > start {
				lines = append(lines, data[start:i])
			}
			start = i + 1
		}
	}
	if start < len(data) {
		lines = append(lines, data[start:])
	}
	return lines
}

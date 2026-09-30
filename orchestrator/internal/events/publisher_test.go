package events

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestKafkaPublisherAllLifecycleEventsAndOfflineFallback(t *testing.T) {
	// Point to unreachable test port to verify offline graceful fallback without crashing
	pub := NewKafkaPublisher("127.0.0.1:59999", "test.topic")
	defer pub.Close()

	testEvents := []SimulationLifecycleEvent{
		{
			EventID:      "evt-test-queued",
			EventType:    EventExperimentQueued,
			ExperimentID: "exp-lifecycle-1",
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]interface{}{"scenario": "basic_flow"},
		},
		{
			EventID:      "evt-test-started",
			EventType:    EventExperimentStarted,
			ExperimentID: "exp-lifecycle-1",
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]interface{}{"status": "RUNNING"},
		},
		{
			EventID:      "evt-test-completed",
			EventType:    EventExperimentCompleted,
			ExperimentID: "exp-lifecycle-1",
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]interface{}{"availability": 98.5},
		},
		{
			EventID:      "evt-test-failed",
			EventType:    EventExperimentFailed,
			ExperimentID: "exp-lifecycle-2",
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]interface{}{"error": "simulation timeout"},
		},
		{
			EventID:      "evt-test-cancelled",
			EventType:    EventExperimentCancelled,
			ExperimentID: "exp-lifecycle-3",
			Timestamp:    time.Now().UTC(),
			Payload:      map[string]interface{}{"reason": "operator cancelled"},
		},
	}

	for _, evt := range testEvents {
		err := pub.Publish(evt)
		if err != nil {
			t.Fatalf("Expected publish to succeed with local buffering, got error: %v", err)
		}
	}

	// Verify local event_stream.jsonl was appended
	data, err := os.ReadFile("event_stream.jsonl")
	if err != nil {
		t.Fatalf("Expected event_stream.jsonl to exist, got error: %v", err)
	}
	defer os.Remove("event_stream.jsonl")

	lines := splitLines(data)
	if len(lines) < len(testEvents) {
		t.Fatalf("Expected at least %d lines in event_stream.jsonl, got %d", len(testEvents), len(lines))
	}

	// Verify the last 5 events correspond to our test events
	tailLines := lines[len(lines)-len(testEvents):]
	for i, lineBytes := range tailLines {
		var parsed SimulationLifecycleEvent
		if err := json.Unmarshal(lineBytes, &parsed); err != nil {
			t.Fatalf("Failed to parse event JSON at index %d: %v", i, err)
		}
		expected := testEvents[i]
		if parsed.EventID != expected.EventID {
			t.Errorf("Index %d: Expected EventID %s, got %s", i, expected.EventID, parsed.EventID)
		}
		if parsed.EventType != expected.EventType {
			t.Errorf("Index %d: Expected EventType %s, got %s", i, expected.EventType, parsed.EventType)
		}
		if parsed.ExperimentID != expected.ExperimentID {
			t.Errorf("Index %d: Expected ExperimentID %s, got %s", i, expected.ExperimentID, parsed.ExperimentID)
		}
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

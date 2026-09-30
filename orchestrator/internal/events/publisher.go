package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

type EventType string

const (
	EventExperimentQueued    EventType = "EXPERIMENT_QUEUED"
	EventExperimentStarted   EventType = "EXPERIMENT_STARTED"
	EventExperimentCompleted EventType = "EXPERIMENT_COMPLETED"
	EventExperimentFailed    EventType = "EXPERIMENT_FAILED"
	EventExperimentCancelled EventType = "EXPERIMENT_CANCELLED"
)

// SimulationLifecycleEvent represents an event published to Kafka / Redpanda.
type SimulationLifecycleEvent struct {
	EventID      string      `json:"event_id"`
	EventType    EventType   `json:"event_type"`
	ExperimentID string      `json:"experiment_id"`
	Timestamp    time.Time   `json:"timestamp"`
	Payload      interface{} `json:"payload,omitempty"`
}

// Publisher defines the contract for broadcasting simulation lifecycle events.
type Publisher interface {
	Publish(event SimulationLifecycleEvent) error
	Close() error
}

// KafkaStreamPublisher handles publishing to a Kafka / Redpanda broker using genuine Kafka wire protocol.
type KafkaStreamPublisher struct {
	mu         sync.Mutex
	writer     *kafka.Writer
	brokerAddr string
	topic      string
}

func NewKafkaPublisher(brokerAddr, topic string) *KafkaStreamPublisher {
	if brokerAddr == "" {
		brokerAddr = os.Getenv("KAFKA_BROKER")
		if brokerAddr == "" {
			brokerAddr = "localhost:9092"
		}
	}
	if topic == "" {
		topic = os.Getenv("KAFKA_TOPIC")
		if topic == "" {
			topic = "faultline.experiments"
		}
	}

	w := &kafka.Writer{
		Addr:         kafka.TCP(brokerAddr),
		Topic:        topic,
		Balancer:     &kafka.LeastBytes{},
		WriteTimeout: 2 * time.Second,
		ReadTimeout:  2 * time.Second,
		MaxAttempts:  3,
	}

	return &KafkaStreamPublisher{
		writer:     w,
		brokerAddr: brokerAddr,
		topic:      topic,
	}
}

func (p *KafkaStreamPublisher) Publish(event SimulationLifecycleEvent) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to marshal event: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	msg := kafka.Message{
		Key:   []byte(event.ExperimentID),
		Value: data,
		Time:  event.Timestamp,
	}

	if p.writer != nil {
		if err := p.writer.WriteMessages(ctx, msg); err != nil {
			log.Printf("[KAFKA] Notice: broker %s not connected (%v). Buffered in local event stream.\n", p.brokerAddr, err)
		} else {
			log.Printf("[KAFKA PUBLISH] Topic: '%s' | Event: %s | ExpID: %s\n", p.topic, event.EventType, event.ExperimentID)
		}
	}

	// Persist event to append-only event-stream file (local Event Sourcing & offline fallback)
	_ = appendEventLog(data)

	return nil
}

func (p *KafkaStreamPublisher) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.writer != nil {
		return p.writer.Close()
	}
	return nil
}

func appendEventLog(data []byte) error {
	f, err := os.OpenFile("event_stream.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

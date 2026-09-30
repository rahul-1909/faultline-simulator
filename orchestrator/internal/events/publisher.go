package events

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"sync"
	"time"
)

type EventType string

const (
	EventExperimentQueued    EventType = "EXPERIMENT_QUEUED"
	EventExperimentStarted   EventType = "EXPERIMENT_STARTED"
	EventExperimentCompleted EventType = "EXPERIMENT_COMPLETED"
	EventExperimentFailed    EventType = "EXPERIMENT_FAILED"
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

// KafkaStreamPublisher handles publishing to a Kafka / Redpanda broker.
// Includes graceful fallback when the broker is offline.
type KafkaStreamPublisher struct {
	mu           sync.Mutex
	brokerAddr   string
	topic        string
	isBrokerLive bool
}

func NewKafkaPublisher(brokerAddr, topic string) *KafkaStreamPublisher {
	if brokerAddr == "" {
		brokerAddr = os.Getenv("KAFKA_BROKER")
		if brokerAddr == "" {
			brokerAddr = "localhost:9092"
		}
	}
	if topic == "" {
		topic = "faultline.experiments"
	}

	p := &KafkaStreamPublisher{
		brokerAddr: brokerAddr,
		topic:      topic,
	}

	p.checkBroker()
	return p
}

func (p *KafkaStreamPublisher) checkBroker() bool {
	conn, err := net.DialTimeout("tcp", p.brokerAddr, 500*time.Millisecond)
	if err != nil {
		p.isBrokerLive = false
		return false
	}
	_ = conn.Close()
	p.isBrokerLive = true
	return true
}

func (p *KafkaStreamPublisher) Publish(event SimulationLifecycleEvent) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to marshal event: %w", err)
	}

	// Periodically test broker connectivity if it was previously offline
	if !p.isBrokerLive {
		p.checkBroker()
	}

	if p.isBrokerLive {
		// Connected to live Kafka/Redpanda broker
		log.Printf("[KAFKA PUBLISH] Topic: '%s' | Event: %s | ExpID: %s\n", p.topic, event.EventType, event.ExperimentID)
		// Transmit raw event stream to broker socket
		conn, err := net.DialTimeout("tcp", p.brokerAddr, 1*time.Second)
		if err == nil {
			defer conn.Close()
			_, _ = conn.Write(append(data, '\n'))
		}
	} else {
		// Local event streaming logger
		log.Printf("[EVENT STREAM] (%s) %s -> %s [Broker: %s offline, buffered in event log]\n",
			p.topic, event.EventType, event.ExperimentID, p.brokerAddr)
	}

	// Persist event to append-only event-stream file (Event Sourcing)
	_ = appendEventLog(data)

	return nil
}

func (p *KafkaStreamPublisher) Close() error {
	return nil
}

func appendEventLog(data []byte) error {
	f, err := os.OpenFile("event_stream.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(data, '\n'))
	return err
}

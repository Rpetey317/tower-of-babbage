// Package contract defines the JSON messages shared by the web app and pipeline.
// The wire format is specified in docs/contract.md and exercised by shared fixtures.
package contract

import (
	"bytes"
	"encoding/json"
	"fmt"
)

const Version = 1

// HealthResponse is returned by GET /healthz.
type HealthResponse struct {
	Status          string           `json:"status"`
	ContractVersion int              `json:"contractVersion"`
	Provider        string           `json:"provider"`
	Endpoints       []EndpointHealth `json:"endpoints"`
	ActiveSessions  int              `json:"activeSessions"`
}

type EndpointHealth struct {
	URL     string `json:"url"`
	Healthy bool   `json:"healthy"`
}

type SessionStats struct {
	AudioReceivedMs int     `json:"audioReceivedMs"`
	ChunksProcessed int     `json:"chunksProcessed"`
	ChunksDropped   int     `json:"chunksDropped"`
	QueueDepth      int     `json:"queueDepth"`
	LatencyP50Ms    int     `json:"latencyP50Ms"`
	LatencyP95Ms    int     `json:"latencyP95Ms"`
	LastError       *string `json:"lastError"`
}

type SessionsResponse struct {
	Sessions []RunningSession `json:"sessions"`
}

type RunningSession struct {
	SessionID string       `json:"sessionId"`
	RunID     string       `json:"runId"`
	Status    string       `json:"status"`
	Stats     SessionStats `json:"stats"`
}

type GlossaryTerm struct {
	Term        string  `json:"term"`
	Translation *string `json:"translation"`
}

// SourceConfig remains raw because the shape depends on Source.Type. The
// supported file_replay shape is FileReplayConfig; other sources are backlog.
type Source struct {
	Type   string          `json:"type"`
	Config json.RawMessage `json:"config"`
}

type FileReplayConfig struct {
	Path string `json:"path"`
	Loop bool   `json:"loop"`
}

type SessionStartRequest struct {
	ContractVersion int            `json:"contractVersion"`
	RunID           string         `json:"runId"`
	Slug            string         `json:"slug"`
	SourceLanguage  string         `json:"sourceLanguage"`
	TargetLanguages []string       `json:"targetLanguages"`
	TranslationMode string         `json:"translationMode"`
	Source          Source         `json:"source"`
	Glossary        []GlossaryTerm `json:"glossary"`
}

type SessionStartResponse struct {
	RunID  string `json:"runId"`
	Status string `json:"status"`
}

type SessionStopRequest struct {
	RunID *string `json:"runId,omitempty"`
}

type SessionStopResponse struct {
	RunID  string `json:"runId"`
	Status string `json:"status"`
}

type GlossaryUpdateRequest struct {
	Glossary []GlossaryTerm `json:"glossary"`
}

type GlossaryUpdateResponse struct {
	Count int `json:"count"`
}

type ControlError struct {
	Error string  `json:"error"`
	RunID *string `json:"runId,omitempty"`
}

// EventBatch contains a tagged Event for each segment, status, or log update.
type EventBatch struct {
	ContractVersion int     `json:"contractVersion"`
	Events          []Event `json:"events"`
}

type EventBatchResponse struct {
	Accepted int `json:"accepted"`
}

type EventBatchError struct {
	Error   string            `json:"error"`
	Details []json.RawMessage `json:"details"`
}

type EventBase struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	RunID     string `json:"runId"`
	EmittedAt string `json:"emittedAt"`
}

type SegmentEvent struct {
	EventBase
	ChunkIndex int    `json:"chunkIndex"`
	Kind       string `json:"kind"`
	Language   string `json:"language"`
	Text       string `json:"text"`
	IsFinal    bool   `json:"isFinal"`
	StartMs    int    `json:"startMs"`
	EndMs      int    `json:"endMs"`
	LatencyMs  int    `json:"latencyMs"`
}

type StatusEvent struct {
	EventBase
	Status string       `json:"status"`
	Stats  SessionStats `json:"stats"`
}

type LogEvent struct {
	EventBase
	Level   string          `json:"level"`
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Event holds exactly one wire variant. It dispatches on type when decoding.
type Event struct {
	Segment *SegmentEvent
	Status  *StatusEvent
	Log     *LogEvent
}

func (event *Event) UnmarshalJSON(data []byte) error {
	var tag struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &tag); err != nil {
		return err
	}
	*event = Event{}
	switch tag.Type {
	case "segment":
		var segment SegmentEvent
		if err := decodeStrict(data, &segment); err != nil {
			return err
		}
		event.Segment = &segment
	case "status":
		var status StatusEvent
		if err := decodeStrict(data, &status); err != nil {
			return err
		}
		event.Status = &status
	case "log":
		var log LogEvent
		if err := decodeStrict(data, &log); err != nil {
			return err
		}
		event.Log = &log
	default:
		return fmt.Errorf("unknown event type %q", tag.Type)
	}
	return nil
}

func (event Event) MarshalJSON() ([]byte, error) {
	if event.Segment != nil && event.Status == nil && event.Log == nil && event.Segment.Type == "segment" {
		return json.Marshal(event.Segment)
	}
	if event.Status != nil && event.Segment == nil && event.Log == nil && event.Status.Type == "status" {
		return json.Marshal(event.Status)
	}
	if event.Log != nil && event.Segment == nil && event.Status == nil && event.Log.Type == "log" {
		return json.Marshal(event.Log)
	}
	return nil, fmt.Errorf("event must contain exactly one variant with its matching type")
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

type IngestHello struct {
	Type       string `json:"type"`
	Format     string `json:"format"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
}

type IngestReady struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	RunID     string `json:"runId"`
}

type IngestStats struct {
	Type            string `json:"type"`
	AudioReceivedMs int    `json:"audioReceivedMs"`
	QueueDepth      int    `json:"queueDepth"`
}

type IngestEnd struct {
	Type string `json:"type"`
}

// IngestTokenClaims is the JSON payload signed by the web app.
type IngestTokenClaims struct {
	SessionID string `json:"sessionId"`
	Exp       int64  `json:"exp"`
}

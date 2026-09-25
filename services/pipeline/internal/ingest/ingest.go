// Package ingest turns audio producers into normalized PCM frames for a
// running session: the operator WebSocket endpoint and the ffmpeg-backed
// file_replay source. See docs/components/ingest.md and contract section 4.
package ingest

import "github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"

// Close codes from contract section 4.
const (
	closeProtocolError = 4000 // missing/invalid hello or unknown text message
	closeInvalidToken  = 4001 // missing, malformed, expired or wrong-session token
	closeNotRunning    = 4004 // no active run for the session id
	closeReplaced      = 4009 // a newer producer took over the run
)

// Sink is the ingest-facing view of one running session; the session runner
// (internal/session) implements it. Producers deliver frames on their own
// goroutine, so implementations must be safe for a single concurrent pusher
// plus Flush from the same goroutine.
type Sink interface {
	// RunID identifies the active run, sent in the ready message.
	RunID() string
	// Push delivers one PCM frame stamped with its audio position.
	Push(frame chunk.Frame)
	// Flush emits whatever audio is buffered, on the client's end message.
	Flush()
	// QueueDepth reports the runner's chunk queue depth for stats messages.
	QueueDepth() int
}

// Sessions resolves a session id to its running session's sink. Implemented
// by the session runner once M1-11 lands; a nil Sessions answers "not running"
// for every id.
type Sessions interface {
	Lookup(sessionID string) (Sink, bool)
}

// Events receives ingest log events destined for the web event stream
// (contract section 6). The emit client implements it; nil disables reporting.
type Events interface {
	Log(sessionID, level, code, message string)
}

func logEvent(events Events, sessionID, level, code, message string) {
	if events != nil {
		events.Log(sessionID, level, code, message)
	}
}

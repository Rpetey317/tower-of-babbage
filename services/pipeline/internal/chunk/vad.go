package chunk

import (
	"encoding/binary"
	"math"
)

// VAD is the energy voice-activity detector from docs/components/ingest.md: a
// 20 ms window is speech when its RMS exceeds an adaptive noise floor times a
// factor. The floor is an exponential moving minimum: it snaps to new minima
// almost immediately and forgets them slowly toward the current level, so it
// follows the room's noise floor without being dragged up by speech itself.
type VAD struct {
	FloorFactor  float64 // speech threshold multiplier over the floor
	MinSpeechRMS float64 // absolute minimum RMS for speech (rejects quiet noise)

	floor float64
}

// NewVAD returns a VAD with the defaults from docs/components/ingest.md.
func NewVAD() *VAD {
	return &VAD{
		FloorFactor:  3,
		MinSpeechRMS: 100, // about -44 dBFS; room noise sits below this
		floor:        100,
	}
}

const (
	// downAlpha pulls the floor to a new minimum in a handful of windows.
	downAlpha = 0.5
	// upAlpha lets the floor forget a minimum over ~80 s of louder audio;
	// slow enough that sustained speech never raises it within one chunk.
	upAlpha = 0.0001
)

// Speech reports whether one 20 ms window (640 bytes of s16le PCM) is speech.
func (v *VAD) Speech(pcm []byte) bool {
	rms := rmsOf(pcm)
	if rms < v.floor {
		v.floor += (rms - v.floor) * downAlpha
	} else {
		v.floor += (rms - v.floor) * upAlpha
	}
	return rms > v.floor*v.FloorFactor && rms > v.MinSpeechRMS
}

// Floor is the current noise-floor estimate, exposed for tests and logging.
func (v *VAD) Floor() float64 {
	return v.floor
}

func rmsOf(pcm []byte) float64 {
	var sum float64
	for i := 0; i+1 < len(pcm); i += 2 {
		sample := float64(int16(binary.LittleEndian.Uint16(pcm[i:])))
		sum += sample * sample
	}
	return math.Sqrt(sum / float64(len(pcm)/2))
}

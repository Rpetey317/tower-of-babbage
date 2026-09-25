package chunk

import (
	"encoding/binary"
	"testing"
)

func dcPCM(ms int, amplitude int16) []byte {
	pcm := make([]byte, ms*bytesPerMs)
	for i := 0; i < len(pcm)/2; i++ {
		binary.LittleEndian.PutUint16(pcm[i*2:], uint16(amplitude))
	}
	return pcm
}

func TestVADClassifiesSpeechAndSilence(t *testing.T) {
	vad := NewVAD()
	for i := 0; i < 50; i++ {
		if vad.Speech(silencePCM(WindowMs)) {
			t.Fatal("silence classified as speech")
		}
	}
	for i := 0; i < 50; i++ {
		if !vad.Speech(tonePCM(WindowMs, 8000)) {
			t.Fatal("tone classified as silence")
		}
	}
	for i := 0; i < 50; i++ {
		if vad.Speech(silencePCM(WindowMs)) {
			t.Fatal("post-speech silence classified as speech")
		}
	}
}

func TestVADRejectsQuietNoise(t *testing.T) {
	vad := NewVAD()
	// Constant noise below the absolute minimum never counts as speech.
	for i := 0; i < 100; i++ {
		if vad.Speech(dcPCM(WindowMs, 60)) {
			t.Fatal("quiet noise classified as speech")
		}
	}
}

func TestVADFloorFollowsLouderNoise(t *testing.T) {
	vad := NewVAD()
	// A louder room (~400 RMS) is speech against the initial floor for a
	// while, then the moving minimum catches up and it becomes silence.
	becameSilence := false
	for i := 0; i < 3000; i++ { // 60 s
		if !vad.Speech(dcPCM(WindowMs, 400)) {
			becameSilence = true
			break
		}
	}
	if !becameSilence {
		t.Fatalf("noise floor never adapted; floor=%f", vad.Floor())
	}
}

func TestVADSustainedSignalStaysSpeech(t *testing.T) {
	// Within one chunk (<= 30 s) a constant-level signal must not decay into
	// silence, or no pause cut would ever fire and max cuts would produce
	// empty chunks.
	vad := NewVAD()
	for i := 0; i < 1600; i++ { // 32 s
		if !vad.Speech(dcPCM(WindowMs, 4000)) {
			t.Fatalf("sustained signal became silence at window %d", i)
		}
	}
}

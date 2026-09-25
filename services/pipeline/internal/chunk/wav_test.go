package chunk

import (
	"encoding/binary"
	"testing"
)

func TestEncodeWAV(t *testing.T) {
	pcm := tonePCM(1000, 8000) // 1 s = 32000 bytes
	wav := EncodeWAV(pcm)
	if len(wav) != 44+len(pcm) {
		t.Fatalf("expected %d bytes, got %d", 44+len(pcm), len(wav))
	}
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" || string(wav[12:16]) != "fmt " || string(wav[36:40]) != "data" {
		t.Fatalf("malformed header: %q %q %q %q", wav[0:4], wav[8:12], wav[12:16], wav[36:40])
	}
	if got := binary.LittleEndian.Uint32(wav[4:8]); got != uint32(36+len(pcm)) {
		t.Fatalf("bad RIFF size %d", got)
	}
	if got := binary.LittleEndian.Uint16(wav[20:22]); got != 1 {
		t.Fatalf("bad audio format %d", got)
	}
	if got := binary.LittleEndian.Uint16(wav[22:24]); got != 1 {
		t.Fatalf("bad channel count %d", got)
	}
	if got := binary.LittleEndian.Uint32(wav[24:28]); got != SampleRate {
		t.Fatalf("bad sample rate %d", got)
	}
	if got := binary.LittleEndian.Uint32(wav[28:32]); got != bytesPerSecond {
		t.Fatalf("bad byte rate %d", got)
	}
	if got := binary.LittleEndian.Uint32(wav[40:44]); got != uint32(len(pcm)) {
		t.Fatalf("bad data size %d", got)
	}
	if string(wav[44:48]) != string(pcm[:4]) {
		t.Fatal("payload does not follow header")
	}
}

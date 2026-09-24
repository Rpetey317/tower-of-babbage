package contract

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

const fixtureDirectory = "../../../../packages/contract/fixtures"

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixtureDirectory, name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestFixtureRoundTrips(t *testing.T) {
	fixtures := map[string]func() any{
		"events.batch.json":           func() any { return new(EventBatch) },
		"healthz.response.json":       func() any { return new(HealthResponse) },
		"ingest.hello.json":           func() any { return new(IngestHello) },
		"ingest.ready.json":           func() any { return new(IngestReady) },
		"ingest.stats.json":           func() any { return new(IngestStats) },
		"session-start.request.json":  func() any { return new(SessionStartRequest) },
		"session-start.response.json": func() any { return new(SessionStartResponse) },
		"sessions.response.json":      func() any { return new(SessionsResponse) },
	}
	entries, err := os.ReadDir(fixtureDirectory)
	if err != nil {
		t.Fatal(err)
	}
	var actual []string
	for _, entry := range entries {
		actual = append(actual, entry.Name())
	}
	var expected []string
	for name := range fixtures {
		expected = append(expected, name)
	}
	expected = append(expected, "ingest-token.vector.json")
	slices.Sort(actual)
	slices.Sort(expected)
	if !slices.Equal(actual, expected) {
		t.Fatalf("fixtures without Go types: got %v, want %v", actual, expected)
	}

	for name, newMessage := range fixtures {
		t.Run(name, func(t *testing.T) {
			original := fixture(t, name)
			message := newMessage()
			if err := json.Unmarshal(original, message); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(message)
			if err != nil {
				t.Fatal(err)
			}
			var want, got any
			if err := json.Unmarshal(original, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("round trip differs: got %s, want %s", encoded, original)
			}
		})
	}
}

func TestEventVariants(t *testing.T) {
	var batch EventBatch
	if err := json.Unmarshal(fixture(t, "events.batch.json"), &batch); err != nil {
		t.Fatal(err)
	}
	if batch.ContractVersion != Version || len(batch.Events) != 4 || batch.Events[0].Segment == nil || batch.Events[1].Segment == nil || batch.Events[2].Status == nil || batch.Events[3].Log == nil {
		t.Fatalf("unexpected event variants: %+v", batch)
	}
	for _, input := range []string{
		`{"type":"unknown"}`,
		`{"type":"segment","unexpected":true}`,
	} {
		var event Event
		if err := json.Unmarshal([]byte(input), &event); err == nil {
			t.Fatalf("accepted invalid event: %s", input)
		}
	}
}

func TestIngestTokenVector(t *testing.T) {
	var vector struct {
		Secret        string `json:"secret"`
		Payload       string `json:"payload"`
		ExpectedToken string `json:"expectedToken"`
	}
	if err := json.Unmarshal(fixture(t, "ingest-token.vector.json"), &vector); err != nil {
		t.Fatal(err)
	}
	var claims IngestTokenClaims
	payload, err := base64.RawURLEncoding.DecodeString(vector.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	key, err := base64.StdEncoding.DecodeString(vector.Secret)
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(vector.Payload))
	if got := vector.Payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)); got != vector.ExpectedToken {
		t.Fatalf("vector mismatch: got %s", got)
	}

	validAt := time.Unix(claims.Exp-1, 0)
	if !VerifyIngestToken(vector.ExpectedToken, claims.SessionID, vector.Secret, validAt) {
		t.Fatal("rejected shared ingest token vector")
	}
	if VerifyIngestToken(vector.ExpectedToken, claims.SessionID, vector.Secret, time.Unix(claims.Exp, 0)) {
		t.Fatal("accepted expired token")
	}
	if VerifyIngestToken(vector.ExpectedToken, "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77", vector.Secret, validAt) {
		t.Fatal("accepted token for a different session")
	}
	parts := strings.Split(vector.ExpectedToken, ".")
	for _, token := range []string{
		"malformed",
		parts[0] + ".A" + parts[1][1:],
		parts[0] + "." + parts[1][:len(parts[1])-1] + "5", // same bytes, non-canonical pad bits
	} {
		if VerifyIngestToken(token, claims.SessionID, vector.Secret, validAt) {
			t.Fatalf("accepted malformed token: %s", token)
		}
	}
	if VerifyIngestToken(vector.ExpectedToken, claims.SessionID, "invalid", validAt) {
		t.Fatal("accepted invalid shared secret")
	}
}

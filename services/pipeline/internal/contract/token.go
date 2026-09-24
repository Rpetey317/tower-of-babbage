package contract

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"time"
)

// VerifyIngestToken checks the signed web token, its expiry, and its session.
// sharedSecret is the base64-encoded SHARED_SECRET from pipeline configuration.
func VerifyIngestToken(token, sessionID, sharedSecret string, now time.Time) bool {
	payload, signature, found := strings.Cut(token, ".")
	if !found || payload == "" || signature == "" || strings.Contains(signature, ".") {
		return false
	}

	key, err := base64.StdEncoding.Strict().DecodeString(sharedSecret)
	if err != nil || len(key) < 32 || base64.StdEncoding.EncodeToString(key) != sharedSecret {
		return false
	}
	supplied, err := base64.RawURLEncoding.Strict().DecodeString(signature)
	if err != nil || base64.RawURLEncoding.EncodeToString(supplied) != signature {
		return false
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	if !hmac.Equal(mac.Sum(nil), supplied) {
		return false
	}

	decoded, err := base64.RawURLEncoding.Strict().DecodeString(payload)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != payload {
		return false
	}
	var claims IngestTokenClaims
	decoder := json.NewDecoder(strings.NewReader(string(decoded)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return false
	}
	return validUUID(claims.SessionID) && claims.SessionID == sessionID && claims.Exp > now.Unix()
}

func validUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if value[index] != '-' {
				return false
			}
			continue
		}
		if value[index] < '0' || value[index] > '9' {
			if value[index] < 'a' || value[index] > 'f' {
				return false
			}
		}
	}
	return true
}

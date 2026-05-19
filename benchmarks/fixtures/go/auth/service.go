package auth

import "context"

type SessionService struct{}

func ValidateSession(ctx context.Context, sessionID string) bool {
	return sessionID != ""
}

import type { AuthenticatedUser } from './auth-service';

export class TokenStore {
  findUser(sessionId: string): AuthenticatedUser | null {
    if (sessionId.length === 0) return null;
    return { id: sessionId, email: 'fixture@example.com' };
  }
}

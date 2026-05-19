import { TokenStore } from './token-store';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export class AuthService {
  constructor(private readonly tokens: TokenStore) {}

  authenticateSession(sessionId: string): AuthenticatedUser | null {
    return this.tokens.findUser(sessionId);
  }
}

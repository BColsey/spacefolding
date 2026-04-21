import { randomUUID } from 'node:crypto';
import type { ContextChunk, TaskDescription } from '../src/types/index.js';

export function getSeedChunks(): ContextChunk[] {
  const now = Date.now();

  return [
    {
      id: randomUUID(),
      source: 'conversation',
      type: 'constraint',
      text: 'All API endpoints must require authentication. No anonymous access is allowed. JWT tokens must be validated on every request.',
      timestamp: now - 1000,
      tokensEstimate: 25,
      childrenIds: [],
      metadata: { role: 'user' },
    },
    {
      id: randomUUID(),
      source: 'conversation',
      type: 'instruction',
      text: 'Fix the login flow to use JWT tokens instead of session cookies. The current session-based approach causes issues with the mobile client.',
      timestamp: now - 2000,
      tokensEstimate: 30,
      childrenIds: [],
      metadata: { role: 'user' },
    },
    {
      id: randomUUID(),
      source: 'file',
      type: 'code',
      text: `import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'dev-secret';

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}`,
      timestamp: now - 5000,
      path: 'src/auth/login.ts',
      language: 'typescript',
      tokensEstimate: 150,
      childrenIds: [],
      metadata: {},
    },
    {
      id: randomUUID(),
      source: 'log',
      type: 'log',
      text: `2024-01-15T10:30:00.123Z ERROR [auth] 401 Unauthorized - /api/login - No token provided
2024-01-15T10:30:01.456Z ERROR [auth] 401 Unauthorized - /api/login - No token provided
2024-01-15T10:30:02.789Z ERROR [auth] 401 Unauthorized - /api/users - Invalid token
2024-01-15T10:30:05.001Z WARN  [auth] Token expired for user_id=42`,
      timestamp: now - 10000,
      tokensEstimate: 80,
      childrenIds: [],
      metadata: {},
    },
    {
      id: randomUUID(),
      source: 'git',
      type: 'diff',
      text: `diff --git a/src/auth/login.ts b/src/auth/login.ts
index abc1234..def5678 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -5,7 +5,7 @@ const SECRET = process.env.JWT_SECRET || 'dev-secret';
 
 export function authenticate(req: Request, res: Response, next: NextFunction) {
-  const token = req.headers.authorization?.split(' ')[1];
+  const token = req.headers.authorization?.replace('Bearer ', '');
   if (!token) {
     return res.status(401).json({ error: 'No token provided' });
   }`,
      timestamp: now - 30000,
      tokensEstimate: 120,
      childrenIds: [],
      metadata: {},
    },
    {
      id: randomUUID(),
      source: 'file',
      type: 'background',
      text: 'Context Steward is a Node.js/TypeScript application that manages context for coding agents. It uses SQLite for local storage and implements hot/warm/cold routing to optimize LLM context windows. The project started in 2024.',
      timestamp: now - 86400000, // 1 day ago
      tokensEstimate: 45,
      path: 'README.md',
      childrenIds: [],
      metadata: {},
    },
    {
      id: randomUUID(),
      source: 'summary',
      type: 'summary',
      text: 'Previous session: Investigated authentication failures. Found that the JWT secret was not being loaded from environment in production. The session-based fallback was causing issues with the mobile API client. Recommended switching to JWT-only auth.',
      timestamp: now - 172800000, // 2 days ago
      tokensEstimate: 40,
      childrenIds: [],
      metadata: {},
    },
    {
      id: randomUUID(),
      source: 'reference',
      type: 'reference',
      text: `JWT payload structure: { userId: string, email: string, role: 'admin'|'user', iat: number, exp: number }. Token expiry: 1 hour for access tokens, 7 days for refresh tokens. Algorithm: HS256.`,
      timestamp: now - 50000,
      tokensEstimate: 50,
      path: 'docs/auth-api.md',
      childrenIds: [],
      metadata: {},
    },
  ];
}

export function getSeedTask(): TaskDescription {
  return {
    text: 'Fix the authentication bug causing 401 errors on login.ts',
    type: 'bug-fix',
    priority: 'high',
  };
}

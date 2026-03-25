# Refactor Auth

Refactor the authentication module to use JWT tokens with refresh flow, add tests, and update docs.

Workers: claude-code, codex

## Task 1: Audit current auth implementation [high]
Read through the existing authentication code. Identify all auth-related files, the current flow (session-based, token-based, etc.), and any security issues. Output a summary.
Files: src/auth/**, src/middleware/auth.ts

## Task 2: Implement JWT token generation [high]
Create a JWT utility module that can generate access tokens (15min TTL) and refresh tokens (7day TTL). Use the audit findings to ensure backward compatibility.
Files: src/auth/jwt.ts, src/auth/tokens.ts
Depends on: 1

## Task 3: Add refresh token endpoint [normal]
Create a POST /auth/refresh endpoint that validates a refresh token and issues a new access token. Include rate limiting.
Files: src/routes/auth.ts, src/middleware/rate-limit.ts
Depends on: 2

## Task 4: Write unit tests for JWT module [normal]
Write comprehensive tests for token generation, validation, expiry, and refresh flow. Cover edge cases like expired tokens, malformed tokens, and replay attacks.
Files: tests/auth/jwt.test.ts, tests/auth/refresh.test.ts
Depends on: 2

## Task 5: Update API documentation [low]
Update the API docs to reflect the new JWT-based auth flow. Include examples for token acquisition, refresh, and error responses.
Files: docs/api/auth.md
Depends on: 3, 4

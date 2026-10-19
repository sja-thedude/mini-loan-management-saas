#!/bin/sh
set -e
# On AWS the DB password arrives as its own secret (injected by ECS from Secrets
# Manager), so the full connection string is assembled here, never stored anywhere.
if [ -z "$DATABASE_URL" ] && [ -n "$DB_HOST" ]; then
  export DATABASE_URL="postgresql://${DB_USER:-loan_app}:${DB_PASSWORD}@${DB_HOST}:5432/${DB_NAME:-loans}?sslmode=require"
fi
node ../../node_modules/prisma/build/index.js migrate deploy
exec node dist/src/server.js

# Build context: repository root (npm workspaces share one lockfile).
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --include-workspace-root=false
COPY apps/api apps/api
RUN npm run build -w apps/api && npm prune --omit=dev -w apps/api --include-workspace-root=false

FROM node:22-alpine
RUN apk add --no-cache openssl
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/docker-entrypoint.sh ./apps/api/docker-entrypoint.sh
WORKDIR /app/apps/api
USER node
EXPOSE 4000
# Learning-project shortcut: the entrypoint applies pending migrations on start (idempotent).
# In production you would run migrations as a separate one-off task before rolling the service.
CMD ["./docker-entrypoint.sh"]

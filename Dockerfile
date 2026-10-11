# syntax=docker/dockerfile:1

# ---- build: compile the TypeScript backend and the React UI ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY web web
RUN npm run build && npm run build:web

# ---- runtime: production dependencies and compiled output only ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
COPY migrations migrations
USER node
EXPOSE 3000
# The same image runs the API (default), the worker and migrations.
CMD ["node", "dist/bin/api.js"]

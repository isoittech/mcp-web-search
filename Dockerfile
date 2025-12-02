# syntax=docker/dockerfile:1

# Build stage: compile TypeScript and install dependencies
FROM node:20-bullseye AS build

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm ci && npm run build

# Runtime stage: minimal Node.js image to run the MCP server
FROM node:20-bullseye

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
# Install only production dependencies; build is already done in the previous stage
RUN npm ci --omit=dev --ignore-scripts

# Copy built JS artifacts
COPY --from=build /app/build ./build

# MCP servers communicate over stdio, so the default command just runs the server
ENTRYPOINT ["node", "build/index.js"]
# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=23.10.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"

# Keep Playwright browsers in a path we can copy between stages.
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci

# Install Chromium for Playwright during build (download once)
RUN npx playwright install chromium

# Copy application code
COPY . .


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Install OS deps required by Playwright Chromium (needs playwright package from /app)
RUN npx playwright install-deps chromium

# Copy Playwright browsers cache
COPY --from=build /ms-playwright /ms-playwright

# Start the server by default, this can be overwritten at runtime
EXPOSE 4000
CMD [ "npm", "run", "start" ]

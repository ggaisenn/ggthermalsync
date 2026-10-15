FROM debian:bookworm-slim AS engine-build

RUN apt-get update \
    && apt-get install --no-install-recommends -y cmake g++ make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY core-engine/ ./core-engine/
RUN cmake -S core-engine -B core-engine/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build core-engine/build --target BATTERYSIM --parallel

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8080 \
    TCP_HOST=0.0.0.0 \
    TCP_PORT=9001

RUN apt-get update \
    && apt-get install --no-install-recommends -y libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/telemetry-backend
COPY telemetry-backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY telemetry-backend/src ./src
COPY scripts/mock-telemetry-stream.js /app/scripts/mock-telemetry-stream.js
COPY scripts/chaos-injector.js /app/scripts/chaos-injector.js
COPY --from=engine-build /src/core-engine/build/BATTERYSIM /app/core-engine/build/BATTERYSIM

ENV CHAOS_PREBUILT_ENGINE=1

EXPOSE 8080 9001
CMD ["node", "src/server.js"]

const express = require('express');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const { createTcpIngestServer } = require('./ingest/tcpIngest');
const RingBuffer = require('./store/ringBuffer');

const HTTP_HOST = process.env.HTTP_HOST || 'localhost';
const HTTP_PORT = Number.parseInt(process.env.HTTP_PORT || '8080', 10);
const TCP_HOST = process.env.TCP_HOST || '127.0.0.1';
const TCP_PORT = Number.parseInt(process.env.TCP_PORT || '9001', 10);
const HISTORY_CAPACITY = Number.parseInt(process.env.HISTORY_CAPACITY || '3600', 10);
const WS_BROADCAST_EVERY = parsePositiveInteger(process.env.WS_BROADCAST_EVERY, 5);

const history = new RingBuffer(HISTORY_CAPACITY);
const app = express();
const httpServer = http.createServer(app);
// Share the HTTP listener for dashboard WebSocket connections.
const webSocketServer = new WebSocketServer({ server: httpServer });
let framesSinceBroadcast = 0;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function broadcastFrame(frame) {
  const payload = JSON.stringify(frame);
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload, (error) => {
        if (error) console.warn(`WebSocket broadcast failed: ${error.message}`);
      });
    }
  }
}

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', buffered_frames: history.size });
});

app.get('/api/history', (request, response) => {
  const requestedLimit = request.query.limit === undefined
    ? history.size
    : parseQueryNumber(request.query.limit);
  if (requestedLimit === null || !Number.isSafeInteger(requestedLimit)) {
    response.status(400).json({ error: 'limit must be a non-negative integer' });
    return;
  }

  const timeframeSeconds = request.query.timeframe === undefined
    ? null
    : parseQueryNumber(request.query.timeframe);
  if (timeframeSeconds !== null && timeframeSeconds < 0) {
    response.status(400).json({ error: 'timeframe must be a non-negative number of seconds' });
    return;
  }
  if (request.query.timeframe !== undefined && timeframeSeconds === null) {
    response.status(400).json({ error: 'timeframe must be a non-negative number of seconds' });
    return;
  }

  let frames = history.snapshot();
  if (timeframeSeconds !== null && frames.length > 0) {
    const latestTimestamp = frames[frames.length - 1].timestamp;
    const cutoff = latestTimestamp - timeframeSeconds;
    frames = frames.filter((frame) => frame.timestamp >= cutoff);
  }
  response.json({ frames: frames.slice(Math.max(0, frames.length - requestedLimit)) });
});

function parseQueryNumber(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const tcpServer = createTcpIngestServer({
  onFrame(frame) {
    history.push(frame);
    framesSinceBroadcast += 1;
    if (framesSinceBroadcast < WS_BROADCAST_EVERY) return;
    framesSinceBroadcast = 0;
    broadcastFrame(frame);
  },
  onInvalidFrame(error) {
    console.warn(`Discarding invalid telemetry frame: ${error.message}`);
  },
  onClientError(error) {
    console.warn(`Telemetry client socket error: ${error.message}`);
  },
});

httpServer.on('error', (error) => {
  console.error(`HTTP server error: ${error.message}`);
  process.exitCode = 1;
});
tcpServer.on('error', (error) => {
  console.error(`TCP ingest server error: ${error.message}`);
  process.exitCode = 1;
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`HTTP and WebSocket service listening on ${HTTP_HOST}:${HTTP_PORT}`);
  console.log(`WebSocket broadcast interval: every ${WS_BROADCAST_EVERY} valid telemetry frames`);
});
tcpServer.listen(TCP_PORT, TCP_HOST, () => {
  console.log(`TCP telemetry ingest listening on ${TCP_HOST}:${TCP_PORT}`);
});

function shutdown() {
  tcpServer.close();
  for (const client of webSocketServer.clients) client.close(1001, 'Server shutting down');
  webSocketServer.close();
  httpServer.close(() => process.exit());
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

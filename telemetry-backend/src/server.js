const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { createTcpIngestServer } = require('./ingest/tcpIngest');
const RingBuffer = require('./store/ringBuffer');

const HTTP_HOST = process.env.HTTP_HOST || 'localhost';
const HTTP_PORT = Number.parseInt(process.env.HTTP_PORT || '8080', 10);
const TCP_HOST = process.env.TCP_HOST || '127.0.0.1';
const TCP_PORT = Number.parseInt(process.env.TCP_PORT || '9001', 10);
const HISTORY_CAPACITY = Number.parseInt(process.env.HISTORY_CAPACITY || '3600', 10);
const WS_BROADCAST_EVERY = parsePositiveInteger(process.env.WS_BROADCAST_EVERY, 5);
const REPO_ROOT = path.resolve(__dirname, '../..');
const WARNING_TEMP_C = 45;
const CRITICAL_TEMP_C = 55;

const history = new RingBuffer(HISTORY_CAPACITY);
const app = express();
const httpServer = http.createServer(app);
// The dashboard may be opened from file:// or a local frontend dev server (for
// example localhost:3000), while this API runs on port 8080.
function isLocalBrowserOrigin(origin) {
  if (!origin || origin === 'null') return true;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch (_) { return false; }
}

app.use('/api', (request, response, next) => {
  const origin = request.headers.origin;
  if (!isLocalBrowserOrigin(origin)) {
    response.status(403).json({ error: 'Dashboard control API is restricted to local browser origins.' });
    return;
  }
  if (origin === 'null') response.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: '2kb' }));
app.use('/api/simulation', (request, response, next) => {
  const address = request.socket.remoteAddress || '';
  const isLoopback = address === '::1' || address === '127.0.0.1'
    || address.startsWith('127.') || address.startsWith('::ffff:127.');
  if (!isLoopback) {
    response.status(403).json({ error: 'Simulation controls are restricted to loopback clients.' });
    return;
  }
  next();
});
// Share the HTTP listener for dashboard WebSocket connections.
const webSocketServer = new WebSocketServer({ server: httpServer });
let framesSinceBroadcast = 0;
let lastSafetyStatus = 'normal';
let simulationProcess = null;
let simulationState = 'idle';
let simulationMode = null;
let simulationExitPromise = Promise.resolve();

webSocketServer.on('connection', (client) => {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({ type: 'simulation_control', state: simulationState, mode: simulationMode }));
  }
  // Seed new dashboards immediately; they should not wait for the next downsample tick.
  const latestFrame = history.snapshot(1)[0];
  if (latestFrame && client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(latestFrame));
  }
});

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

function applyBackendSafetyPolicy(frame) {
  const cellTemps = frame.cell_temps;
  const hottestTemperature = Math.max(...cellTemps);
  const hottestCellIndex = cellTemps.indexOf(hottestTemperature);
  const warningThreshold = Number.isFinite(frame.warning_threshold) ? frame.warning_threshold : WARNING_TEMP_C;
  const criticalThreshold = Number.isFinite(frame.critical_threshold) ? frame.critical_threshold : CRITICAL_TEMP_C;
  const safetyStatus = hottestTemperature >= criticalThreshold ? 'critical'
    : hottestTemperature >= warningThreshold ? 'warning' : 'normal';
  const backendSafetyTrigger = safetyStatus === 'normal' ? null : {
    level: safetyStatus,
    cell_number: hottestCellIndex + 1,
    temperature_c: hottestTemperature,
    action: safetyStatus === 'critical' ? 'request_maximum_cooling' : 'request_increased_cooling',
    requested_fan_speed: safetyStatus === 'critical' ? 100 : null,
  };

  return {
    ...frame,
    warning_threshold: warningThreshold,
    critical_threshold: criticalThreshold,
    max_cell_temp: hottestTemperature,
    safety_status: safetyStatus,
    backend_safety_trigger: backendSafetyTrigger,
  };
}

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', buffered_frames: history.size });
});

app.get('/api/simulation/status', (_request, response) => {
  response.json({ state: simulationState, mode: simulationMode, pid: simulationProcess?.pid ?? null });
});

function publishSimulationState() {
  const message = JSON.stringify({ type: 'simulation_control', state: simulationState, mode: simulationMode });
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function clearSimulationTelemetry() {
  history.clear();
  framesSinceBroadcast = 0;
  lastSafetyStatus = 'normal';
  const resetMessage = JSON.stringify({ type: 'simulation_reset' });
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(resetMessage);
  }
}

function startManagedSimulation(mode) {
  if (simulationProcess && simulationProcess.exitCode === null) {
    return { error: `A ${simulationMode || 'simulation'} process is already ${simulationState}. Reset it before starting another.` };
  }
  const args = mode === 'chaos'
    ? [path.join(REPO_ROOT, 'scripts/chaos-injector.js')]
    : [path.join(REPO_ROOT, 'scripts/mock-telemetry-stream.js'), ...(mode === 'overheat' ? ['--overheat'] : [])];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  simulationProcess = child;
  simulationMode = mode;
  simulationState = 'running';
  simulationExitPromise = new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`Could not start ${mode} simulation: ${error.message}`);
      if (simulationProcess === child) {
        simulationProcess = null;
        simulationState = 'error';
        publishSimulationState();
      }
      resolve();
    });
    child.once('close', (code, signal) => {
      console.log(`${mode} simulation ended${signal ? ` (${signal})` : ` with exit code ${code}`}.`);
      if (simulationProcess === child) {
        simulationProcess = null;
        simulationState = code === 0 ? 'completed' : 'stopped';
        publishSimulationState();
      }
      resolve();
    });
  });
  publishSimulationState();
  return { state: simulationState, mode: simulationMode, pid: child.pid };
}

function signalSimulation(signal) {
  if (!simulationProcess || simulationProcess.exitCode !== null) return false;
  try {
    if (process.platform !== 'win32' && simulationProcess.pid) process.kill(-simulationProcess.pid, signal);
    else simulationProcess.kill(signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

app.post('/api/simulation/start', (request, response) => {
  const mode = request.body?.scenario;
  if (!['normal', 'overheat'].includes(mode)) {
    response.status(400).json({ error: 'scenario must be normal or overheat' });
    return;
  }
  if (simulationProcess && simulationProcess.exitCode === null) {
    response.status(409).json({ error: `A ${simulationMode || 'simulation'} process is already ${simulationState}. Reset it before starting another.` });
    return;
  }
  clearSimulationTelemetry();
  const result = startManagedSimulation(mode);
  response.status(result.error ? 409 : 202).json(result);
});

app.post('/api/simulation/chaos', (_request, response) => {
  if (simulationProcess && simulationProcess.exitCode === null) {
    response.status(409).json({ error: `A ${simulationMode || 'simulation'} process is already ${simulationState}. Reset it before starting another.` });
    return;
  }
  clearSimulationTelemetry();
  const result = startManagedSimulation('chaos');
  response.status(result.error ? 409 : 202).json(result);
});

app.post('/api/simulation/pause', (_request, response) => {
  if (process.platform === 'win32') {
    response.status(501).json({ error: 'Pause and resume process controls are currently supported on macOS and Linux.' });
    return;
  }
  if (!simulationProcess || simulationProcess.exitCode !== null) {
    response.status(409).json({ error: 'There is no running simulation to pause or resume.' });
    return;
  }
  try {
    const nextState = simulationState === 'paused' ? 'running' : 'paused';
    if (!signalSimulation(nextState === 'paused' ? 'SIGSTOP' : 'SIGCONT')) {
      response.status(409).json({ error: 'The simulation process has already exited.' });
      return;
    }
    simulationState = nextState;
    publishSimulationState();
    response.json({ state: simulationState, mode: simulationMode });
  } catch (error) {
    response.status(500).json({ error: `Could not change simulation state: ${error.message}` });
  }
});

app.post('/api/simulation/reset', async (_request, response) => {
  try {
    if (simulationProcess && simulationProcess.exitCode === null) {
      const child = simulationProcess;
      signalSimulation('SIGTERM');
      await Promise.race([simulationExitPromise, new Promise((resolve) => setTimeout(resolve, 1500))]);
      if (child.exitCode === null) {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await Promise.race([simulationExitPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
      }
    }
    simulationProcess = null;
    simulationMode = null;
    simulationState = 'idle';
    clearSimulationTelemetry();
    publishSimulationState();
    response.json({ state: simulationState });
  } catch (error) {
    response.status(500).json({ error: `Could not reset simulation: ${error.message}` });
  }
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
    frame = applyBackendSafetyPolicy(frame);
    if (frame.safety_status !== lastSafetyStatus) {
      if (frame.backend_safety_trigger) {
        console.warn(`Backend safety trigger ${frame.safety_status}: Cell #${frame.backend_safety_trigger.cell_number} at ${frame.max_cell_temp.toFixed(2)}°C; ${frame.backend_safety_trigger.action}.`);
      }
      lastSafetyStatus = frame.safety_status;
    }
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
  if (simulationProcess && simulationProcess.exitCode === null) {
    try {
      if (process.platform !== 'win32' && simulationProcess.pid) process.kill(-simulationProcess.pid, 'SIGTERM');
      else simulationProcess.kill('SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') console.warn(`Could not stop simulation process: ${error.message}`); }
  }
  tcpServer.close();
  for (const client of webSocketServer.clients) client.close(1001, 'Server shutting down');
  webSocketServer.close();
  httpServer.close(() => process.exit());
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

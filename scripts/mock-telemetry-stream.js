#!/usr/bin/env node
'use strict';

const net = require('node:net');

const host = process.env.TELEMETRY_HOST || process.env.TCP_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.TELEMETRY_PORT || process.env.TCP_PORT || '9001', 10);
const requestedRate = Number.parseInt(process.env.MOCK_TELEMETRY_HZ || '20', 10);
const framesPerSecond = Number.isFinite(requestedRate) ? Math.min(60, Math.max(1, requestedRate)) : 20;
const overheatMode = process.argv.includes('--overheat');
const intervalMs = 1000 / framesPerSecond;
const startedAt = Date.now();
let timer;
let frameNumber = 0;

const socket = net.createConnection({ host, port });
socket.setNoDelay(true);

socket.once('connect', () => {
  console.log(`Mock telemetry streaming to ${host}:${port} at ${framesPerSecond} Hz${overheatMode ? ' (overheat scenario)' : ''}.`);
  timer = setInterval(sendFrame, intervalMs);
  sendFrame();
});

socket.on('error', (error) => {
  console.error(`Could not connect to telemetry backend at ${host}:${port}: ${error.message}`);
  process.exitCode = 1;
  if (timer) clearInterval(timer);
});

function sendFrame() {
  if (!socket.writable) return;
  const timestamp = (Date.now() - startedAt) / 1000;
  const driveWave = Math.sin(timestamp * 0.22);
  const heatRise = overheatMode ? Math.min(timestamp * 1.35, 22) : 0;
  const baseline = 33.5 + driveWave * 2.2 + heatRise;
  const cell_temps = Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    const packGradient = (row - 1.5) * 0.32 + (column - 1.5) * 0.2;
    const localVariation = Math.sin(timestamp * 0.6 + index * 0.73) * 0.45;
    return Number((baseline + packGradient + localVariation).toFixed(2));
  });
  const temp_avg = Number((cell_temps.reduce((sum, value) => sum + value, 0) / cell_temps.length).toFixed(2));
  const peak = Math.max(...cell_temps);
  const fan_speed = Number(Math.max(0, Math.min(100, 38 + (temp_avg - 35) * 7)).toFixed(1));
  const frame = {
    timestamp: Number(timestamp.toFixed(3)),
    temp_avg,
    fan_speed,
    fan_rpm: Math.round(fan_speed * 48),
    cell_temps,
    warning_threshold: 45,
    critical_threshold: 55,
    overheat: peak >= 55,
  };

  socket.write(`${JSON.stringify(frame)}\n`);
  frameNumber += 1;
  if (frameNumber % (framesPerSecond * 5) === 0) {
    console.log(`t=${frame.timestamp.toFixed(1)}s avg=${temp_avg.toFixed(1)}°C max=${peak.toFixed(1)}°C fan=${fan_speed.toFixed(0)}%`);
  }
}

function shutdown() {
  if (timer) clearInterval(timer);
  socket.end();
  console.log('\nMock telemetry stopped.');
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

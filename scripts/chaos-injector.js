#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('../telemetry-backend/node_modules/ws');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'core-engine', 'build');
const enginePath = path.join(buildDir, 'BATTERYSIM');
const httpHost = process.env.TELEMETRY_HTTP_HOST || '127.0.0.1';
const httpPort = Number.parseInt(process.env.HTTP_PORT || '8080', 10);
const wsHost = process.env.TELEMETRY_WS_HOST || '127.0.0.1';
const wsPort = Number.parseInt(process.env.WS_PORT || String(httpPort), 10);
const spikeAt = readStep('--spike-at', 100);
const pumpJamAt = readStep('--pump-jam-at', 0);
const cellRecoverAt = readOptionalStep('--recover-cell3-at');
const pumpRecoverAt = readOptionalStep('--pump-recover-at');
const timeoutMs = 30000;

function readOptionalStep(option) {
  const index = process.argv.indexOf(option);
  if (index === -1) return null;
  const value = Number.parseInt(process.argv[index + 1], 10);
  if (!Number.isInteger(value) || value < 0 || value >= 1000) {
    throw new Error(`${option} must be a simulation step from 0 to 999`);
  }
  return value;
}

function readStep(option, fallback) {
  const value = readOptionalStep(option);
  return value === null ? fallback : value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

async function ensureEngineBuilt() {
  if (process.env.CHAOS_PREBUILT_ENGINE === '1' && fs.existsSync(enginePath)) return;
  if (!fs.existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
    run('cmake', ['-S', 'core-engine', '-B', 'core-engine/build']);
  }
  run('cmake', ['--build', 'core-engine/build', '--config', 'Release']);
  if (!fs.existsSync(enginePath)) throw new Error(`Engine executable not found at ${enginePath}`);
}

async function verifyBackend() {
  const response = await fetch(`http://${httpHost}:${httpPort}/api/health`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`Backend health endpoint returned HTTP ${response.status}`);
  const health = await response.json();
  console.log(`[backend] reachable; ${health.buffered_frames} frames currently buffered`);
}

async function runChaosScenario() {
  const observations = {
    engineFrames: 0,
    warningTrigger: null,
    cell3Critical: null,
    pidOverride: null,
    backendTrigger: null,
  };
  const socket = new WebSocket(`ws://${wsHost}:${wsPort}`);
  let engine;
  let timeout;

  const finish = (resolve, reject, error) => {
    clearTimeout(timeout);
    if (engine && engine.exitCode === null) engine.kill('SIGTERM');
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    if (error) reject(error);
    else resolve();
  };

  return new Promise((resolve, reject) => {
    timeout = setTimeout(() => finish(resolve, reject, new Error(`Timed out after ${timeoutMs / 1000}s waiting for the engine safety path`)), timeoutMs);
    socket.once('error', (error) => finish(resolve, reject, new Error(`WebSocket connection failed: ${error.message}`)));
    socket.once('open', () => {
      console.log(`[websocket] subscribed at ws://${wsHost}:${wsPort}`);
      const args = [
        '--cell3-resistance-spike-at', String(spikeAt),
        '--pump-jam-at', String(pumpJamAt),
      ];
      if (cellRecoverAt !== null) args.push('--cell3-resistance-recover-at', String(cellRecoverAt));
      if (pumpRecoverAt !== null) args.push('--pump-recover-at', String(pumpRecoverAt));
      engine = spawn(enginePath, args, { cwd: root, stdio: 'inherit' });
      engine.once('error', (error) => finish(resolve, reject, new Error(`Could not start engine: ${error.message}`)));
      engine.once('close', (code, signal) => {
        if (code !== 0) {
          finish(resolve, reject, new Error(`Engine exited with code ${code}${signal ? ` (${signal})` : ''}`));
          return;
        }
        // Let the backend flush its downsampled WebSocket broadcasts after the engine exits.
        setTimeout(() => {
          try {
            if (observations.engineFrames === 0) throw new Error('No core-engine frames reached the WebSocket subscriber');
            if (!observations.warningTrigger) throw new Error('Backend did not emit a warning trigger at 45 °C');
            if (!observations.cell3Critical) throw new Error('Cell #3 did not cross the 55 °C critical limit');
            if (!observations.pidOverride) throw new Error('No critical-temperature PID override to 100% cooling was observed');
            if (!observations.backendTrigger) throw new Error('Backend did not emit its automated critical safety trigger');
            console.log(`[PASS] Engine → TCP → backend → WebSocket: received ${observations.engineFrames} engine frames`);
            console.log(`[PASS] Backend warning trigger: Cell #${observations.warningTrigger.cell_number} crossed 45 °C`);
            console.log(`[PASS] Cell #3 thermal spike: ${observations.cell3Critical.temperature.toFixed(2)} °C; backend classified CRITICAL`);
            console.log(`[PASS] PID override: ${observations.pidOverride.pid_output.toFixed(2)}% → ${observations.pidOverride.fan_speed.toFixed(2)}% cooling`);
            console.log(`[PASS] Backend safety trigger: ${observations.backendTrigger.action} for Cell #${observations.backendTrigger.cell_number}`);
            finish(resolve, reject);
          } catch (error) {
            finish(resolve, reject, error);
          }
        }, 350);
      });
    });

    socket.on('message', (payload) => {
      let frame;
      try { frame = JSON.parse(payload.toString()); } catch (_) { return; }
      if (frame.source !== 'core-engine') return;
      observations.engineFrames += 1;
      const cell3Temperature = Number(frame.cell_temps?.[2]);
      if (cell3Temperature >= 45 && frame.safety_status === 'warning' && frame.backend_safety_trigger?.level === 'warning') {
        observations.warningTrigger = frame.backend_safety_trigger;
      }
      if (cell3Temperature >= 55 && frame.safety_status === 'critical') {
        observations.cell3Critical = { temperature: cell3Temperature };
      }
      if (cell3Temperature >= 55 && frame.fan_override === true && frame.fan_speed === 100 && frame.pid_output < 100) {
        observations.pidOverride = { pid_output: frame.pid_output, fan_speed: frame.fan_speed };
      }
      if (frame.backend_safety_trigger?.level === 'critical' && frame.backend_safety_trigger.cell_number === 3) {
        observations.backendTrigger = frame.backend_safety_trigger;
      }
    });
  });
}

async function main() {
  if (cellRecoverAt !== null && cellRecoverAt <= spikeAt) throw new Error('--recover-cell3-at must be later than --spike-at');
  if (pumpRecoverAt !== null && pumpRecoverAt <= pumpJamAt) throw new Error('--pump-recover-at must be later than --pump-jam-at');
  await verifyBackend();
  await ensureEngineBuilt();
  console.log(`[chaos] Cell #3 resistance spike at step ${spikeAt}; pump jam at step ${pumpJamAt}`);
  await runChaosScenario();
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
});

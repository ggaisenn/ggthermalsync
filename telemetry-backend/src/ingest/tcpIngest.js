const net = require('node:net');

const MAX_FRAME_LENGTH = 64 * 1024;
const CELL_COUNT = 16;

function isTelemetryFrame(frame) {
  return frame !== null
    && typeof frame === 'object'
    && Number.isFinite(frame.timestamp)
    && Number.isFinite(frame.temp_avg)
    && Number.isFinite(frame.fan_speed)
    && Array.isArray(frame.cell_temps)
    && frame.cell_temps.length === CELL_COUNT
    && frame.cell_temps.every(Number.isFinite);
}

function createTcpIngestServer({ onFrame, onInvalidFrame }) {
  if (typeof onFrame !== 'function') {
    throw new TypeError('onFrame callback is required');
  }

  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('error', (error) => {
      if (onInvalidFrame) onInvalidFrame(error, '');
    });

    socket.on('data', (chunk) => {
      pending += chunk;
      if (pending.length > MAX_FRAME_LENGTH && !pending.includes('\n')) {
        socket.destroy(new Error('Telemetry frame exceeds the maximum length'));
        return;
      }

      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).trim();
        pending = pending.slice(newlineIndex + 1);
        if (line.length > MAX_FRAME_LENGTH) {
          socket.destroy(new Error('Telemetry frame exceeds the maximum length'));
          return;
        }
        if (line.length > 0) {
          try {
            const frame = JSON.parse(line);
            if (!isTelemetryFrame(frame)) {
              throw new Error('Frame does not match the telemetry schema');
            }
            onFrame(frame);
          } catch (error) {
            if (onInvalidFrame) onInvalidFrame(error, line);
          }
        }
        newlineIndex = pending.indexOf('\n');
      }

      if (pending.length > MAX_FRAME_LENGTH) {
        socket.destroy(new Error('Telemetry frame exceeds the maximum length'));
      }
    });
  });
}

module.exports = { createTcpIngestServer, isTelemetryFrame };

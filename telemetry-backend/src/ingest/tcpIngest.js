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

function createTcpIngestServer({ onFrame, onInvalidFrame, onClientError }) {
  if (typeof onFrame !== 'function') {
    throw new TypeError('onFrame callback is required');
  }

  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('error', (error) => {
      if (onClientError) onClientError(error);
      else console.warn(`Telemetry client socket error: ${error.message}`);
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
          let frame;
          try {
            frame = JSON.parse(line);
          } catch (error) {
            reportInvalidFrame(error, line, onInvalidFrame);
            newlineIndex = pending.indexOf('\n');
            continue;
          }
          if (!isTelemetryFrame(frame)) {
            reportInvalidFrame(new Error('Frame does not match the telemetry schema'), line, onInvalidFrame);
            newlineIndex = pending.indexOf('\n');
            continue;
          }
          try {
            onFrame(frame);
          } catch (error) {
            console.error(`Telemetry frame handler failed: ${error.message}`);
          }
        }
        newlineIndex = pending.indexOf('\n');
      }

      if (pending.length > MAX_FRAME_LENGTH) {
        socket.destroy(new Error('Telemetry frame exceeds the maximum length'));
      }
    });

    socket.on('end', () => {
      if (pending.trim().length > 0) {
        reportInvalidFrame(new Error('Connection ended before the NDJSON newline delimiter'), pending, onInvalidFrame);
      }
    });
  });
}

function reportInvalidFrame(error, line, onInvalidFrame) {
  if (onInvalidFrame) onInvalidFrame(error, line);
  else console.warn(`Discarding invalid telemetry frame: ${error.message}`);
}

module.exports = { createTcpIngestServer, isTelemetryFrame };

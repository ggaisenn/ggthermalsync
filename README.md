# ggthermalsync

A multithreaded C++17 thermal physics engine and real-time telemetry pipeline that simulates an EV battery pack's thermal behavior, manages it with a PID-controlled cooling loop, and streams live JSON telemetry to an ingestion backend for dashboard visualization and automated fault handling.


## The System

Lithium-ion cells operate in a danger zone: too hot, and they enter thermal runaway; too cold, and they lose capacity. Thermal management is the difference between a battery that survives 300,000 km and one that fails in its first year.

`ggthermalsync` is a sandbox for that problem — a full-stack simulation of a 16-cell EV battery pack where every layer of a real telemetry system exists in miniature:

- A **C++ physics engine** that integrates each cell's temperature dynamics at a fixed 60 Hz timestep
- A **PID controller** that throttles a virtual cooling pump to hold pack temperature at a 35°C setpoint
- A **live ingestion pipeline** that streams every simulation frame as JSON over the network
- A **real-time dashboard** that renders the pack as a 3D heatmap with rolling temperature history


## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                            CORE ENGINE  (C++17)                      │
│                                                                      │
│  ┌──────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │
│  │ BatteryPack  │───▶│ PidController   │    │ 16 BatteryCells     │  │
│  │ 4x4 grid     │    │ avg temp ─▶ fan │───▶│ Newton's cooling +  │  │
│  │ ±noise init  │    │ 0-100%, clamp   │    │ Joule heat, Euler   │  │
│  └──────┬───────┘    │ + anti-windup   │    └──────────┬──────────┘  │
│         │            └─────────────────┘               │             │
│         │             cell temps, fan cmd @ 60Hz       │             │
│         └───────────────────────┬──────────────────────┘             │
│                    JSON encoder (hand-rolled, NDJSON)                │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │ TCP :9001, newline-delimited JSON
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       TELEMETRY BACKEND  (Node.js)                   │
│                                                                      │
│   ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐   │
│   │ TCP ingress  │──▶│ ring buffer  │──▶│ WebSocket broadcast    │   │
│   │ parse+verify │   │ last N frames│   │ 10-15Hz downsampled    │   │
│   └──────────────┘   └──────┬───────┘   └───────────┬────────────┘   │
│                             │                       │                │
│                   /api/history (full         client frames @ 10-15Hz │
│                   rate, N frames)                  │                 │
└─────────────────────────────────┼───────────────────┼────────────────┘
                                  ▼                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          WEB DASHBOARD  (browser)                    │
│                                                                      │
│   Three.js 3D heatmap · temp→color mapping · hover tooltips          │
│   Chart.js ~60s rolling avg-temp / fan-speed · overheat alerts       │
└──────────────────────────────────────────────────────────────────────┘
```

## Tier 1 — Core Engine (`core-engine/`, C++17 + CMake)

The physics layer. Each `BatteryCell` integrates its own thermal state:

```
dT/dt = heatGen − k · (T − T_ambient)        // Newton's cooling + heat rise
T(i+1) = T(i) + dt · dT/dt                   // Euler integration @ 60Hz fixed step
```

| Module | Responsibility |
|--------|----------------|
| `BatteryCell` | Per-cell thermal state: id, temperature, Newton's cooling dynamics, Euler integration |
| `BatteryPack` | 4x4 grid of cells, initial ±noise distribution, pack-level avg/max aggregation |
| `PidController` | P/I/D terms, actuator clamping (0–100%), anti-windup; drives the cooling pump against a 35°C setpoint |
| `main` | Fixed-timestep simulation loop, drive-cycle load profile, frame emission |

**Design decisions:**

- **Euler over RK4** — at a fixed 60 Hz step, first-order integration is stable, deterministic, and fast enough that the whole 16-cell pack simulates in microseconds per frame. Determinism matters more than accuracy here: the same input must produce the same frame every run, or the telemetry is meaningless.
- **Cell-level physics, pack-level control** — temperature spread across the pack is exactly what kills real batteries (hot-spot cells age out first). Simulating per-cell and controlling on the average preserves that fidelity while keeping the control loop simple.
- **Zero external dependencies** — the engine links only the standard library. The JSON encoder is a hand-rolled string builder, chosen over a library so the wire format is fully owned and understood.

## Tier 2 — Telemetry Backend (`telemetry-backend/`, Node.js)

The ingestion layer. Listens on TCP `:9001`, reads newline-delimited JSON frames, validates them, and fans them out to clients.

| Component | Responsibility |
|-----------|----------------|
| TCP ingress | Accept engine connections, parse + validate NDJSON frames |
| Ring buffer | Keep the last N full-rate frames for history queries |
| WebSocket hub | Broadcast to all dashboard clients, downsampled to 10–15 Hz to protect browser rendering |
| REST API | `/api/history` (full-rate backfill), `/api/health` (liveness) |


`GET /api/resource` returns chronological data. Use parameters to filter your results, for example `/api/resource?param1=value1&param2=value2`. 

In zsh, quote URLs that contain query parameters: 

```bash
curl -i "http://localhost:8080/api/resource?param1=value1"
```

**Design decisions:**

- **Plain TCP + newline-delimited JSON instead of a fancier transport** — at 60 Hz and ~1 KB per frame, the bandwidth budget is trivial, and the wire format is debuggable with `nc -l 9001` and `json.tool`. No serialization framework, no protocol versioning headaches.
- **Downsampled broadcast, full-rate history** — the dashboard doesn't need 60 fps of chart data, but forensic analysis does. The ring buffer keeps everything; the broadcast sends only what the human eye can consume.

## Tier 3 — Web Dashboard (Three.js + Chart.js)

The visualization layer. Renders the 4x4 pack as a 3D heatmap of colored cell boxes with per-frame temperature updates, hover raycasting for per-cell readouts, a live HUD (avg temp / fan speed / fps), and a rolling 60-second history chart. An overheat scenario trips a visual alert.

## Build & Run

```bash
# Tier 1 — the engine
cmake -S core-engine -B core-engine/build
cmake --build core-engine/build --target BATTERYSIM
./core-engine/build/BATTERYSIM
```

Start the telemetry backend in one terminal:

```bash
cd telemetry-backend
npm install
npm start
```

To exercise the dashboard without the C++ engine, start the mock stream from the repository root in another terminal:

```bash
node scripts/mock-telemetry-stream.js
```

Use `node scripts/mock-telemetry-stream.js --overheat` to trigger the thermal warning path. Set `MOCK_TELEMETRY_HZ` to change its rate (1–60 Hz).

Connect a WebSocket client from another terminal:

```bash
npx wscat -c ws://localhost:8080
```

## Telemetry Payload

Every simulation frame is emitted as a single line of JSON:

```json
{"timestamp": 27.264, "temp_avg": 34.97, "fan_speed": 62.4, "cell_temps": [34.2, 34.9, 35.1, ...]}
```

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | `number` | Simulation time in seconds |
| `temp_avg` | `number` | Pack mean temperature (°C) |
| `fan_speed` | `number` | PID-commanded cooling pump output (0–100%) |
| `cell_temps` | `number[]` | Per-cell temperatures (°C), 16 entries in grid order |

## Repository Layout

```
ggthermalsync/
├── LICENSE.txt
├── README.md
├── core-engine/              # Tier 1 — C++17 thermal physics engine (CMake)
│   ├── CMakeLists.txt
│   ├── include/
│   │   └── BatteryCell.h
│   └── src/
│       ├── BatteryCell.cpp
│       ├── BatteryPack.cpp
│       └── main.cpp
└── telemetry-backend/        # Tier 2 — Node.js ingestion pipeline (in progress)
```

## Status

| Phase | Scope | State |
|-------|-------|-------|
| M1 — Physics engine | Cell thermal model, 4x4 pack simulation, deterministic 60 Hz loop, drive-cycle load profiles | Complete |
| M1 — Control loop | PID with anti-windup, setpoint regulation, tuning | In progress |
| M2 — Telemetry pipeline | TCP stream at 30–60 Hz, reconnects with backoff, ingestion backend, ring buffer, WebSocket hub | In progress |
| M3 — Dashboard | 3D heatmap, live HUD, rolling charts, backfill on connect | Planned |
| M4 — Hardening | Jitter tuning, multi-client load, overheat alerting, end-to-end demo | Planned |

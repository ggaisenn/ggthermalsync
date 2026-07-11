## ggthermalsync
A Multithreaded C++ Physics Engine and Real-Time Telemetry Pipeline for EV Battery Thermal Management.

## What does it do?

A C++ physics engine that 

- Simulates an EV battery's thermal behavior 
- Uses a mathematical PID control loop to manage a virtual cooling pump

A Real-Tim Telemetry Pipeline that 

- Continuously streams live JSON telemetry data over a network to an ingestion backend for real-time dashboard visualization and automated fault-handling.

## Project Layout

```
ggthermalsync/
├── .gitignore
├── README.md
├── LICENSE
│
├── core-engine/              # C++ Physics Core
├── telemetry-backend/       # Node.js Data Ingestion Pipeline
```
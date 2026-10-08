#include <algorithm>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include "BatteryCell.h"
#include "JsonEncoder.h"
#include "PidController.h"
#include "TcpClient.h"
using namespace std;

int main() {
    constexpr int NUM_CELLS = 16;
    constexpr double DT = 0.016;       // Fixed timestep (~60Hz)
    constexpr int TOTAL_STEPS = 1000;

    // A Pack of 16 cells with slight initial variations (20.0°C to 21.5°C)
    std::vector<BatteryCell> batteryPack;
    batteryPack.reserve(NUM_CELLS);

    for (int i = 0; i < NUM_CELLS; ++i) {
        double initialTemp = 20.0 + (i * 0.1);
        batteryPack.emplace_back(i, initialTemp);
    }

    cout << "Starting EV Battery Thermal Simulation...\n";
    cout << "--------------------------------------------------------\n";

    this_thread::sleep_for(std::chrono::milliseconds(2000));  

    double simTime = 0.0;
    double heatGen = 5.0;       // Internal heat generation
    PidController controller;
    TcpClient telemetryClient("127.0.0.1", 9001);
    bool connectionWarningShown = false;

    // Simulation loop for 1,000 steps
    for (int step = 0; step < TOTAL_STEPS; ++step) {
        
        double sumTemp = 0.0;
        double maxTemp = batteryPack[0].temperature();
        std::vector<double> cellTemps;
        cellTemps.reserve(NUM_CELLS);
        for (const auto& cell : batteryPack) {
            const double temp = cell.temperature();
            sumTemp += temp;
            maxTemp = std::max(maxTemp, temp);
            cellTemps.push_back(temp);
        }

        const double avgTemp = sumTemp / NUM_CELLS;
        const double fanSpeed = controller.update(avgTemp, DT);
        const std::string frame = JsonEncoder::encode(simTime, avgTemp, fanSpeed, cellTemps);
        if (!telemetryClient.sendFrame(frame)) {
            if (!connectionWarningShown) {
                cerr << "Telemetry server unavailable at 127.0.0.1:9001; retrying.\n";
                connectionWarningShown = true;
            }
        } else if (connectionWarningShown) {
            cout << "Telemetry connection restored.\n";
            connectionWarningShown = false;
        }

        // Print telemetry every 100 steps
        if (step % 100 == 0) {
            cout << fixed << std::setprecision(2)
                 << "t=" << std::setw(5) << simTime << "s | "
                 << "cell0=" << batteryPack[0].temperature() << "°C | "
                 << "avg=" << avgTemp << "°C | "
                 << "max=" << maxTemp << "°C | fan=" << fanSpeed << "%\n";
        }

        // Updating physics for each individual cell in the BatteryPack
        const double coolingPower = fanSpeed / 100.0;
        for (auto& cell : batteryPack) {
            cell.update(DT, heatGen, coolingPower);
        }

        simTime += DT;
    }

    this_thread::sleep_for(std::chrono::milliseconds(2000));  

    cout << "--------------------------------------------------------\n";
    cout << "Simulation complete.\n";

    return 0;
}

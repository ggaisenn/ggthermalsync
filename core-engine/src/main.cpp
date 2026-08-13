#include <iomanip>
#include <iostream>
#include <vector>
#include "BatteryCell.h"
using namespace std;

int main() {
    constexpr int NUM_CELLS = 16;
    constexpr double DT = 0.016;       // Fixed timestep (~60Hz)
    constexpr int TOTAL_STEPS = 1000;

    // A Pack of 16 cells with slight initial variations (20.0°C to 21.5°C)
    std::vector<BatteryCell> BatteryPack;
    BatteryPack.reserve(NUM_CELLS);

    for (int i = 0; i < NUM_CELLS; ++i) {
        double initialTemp = 20.0 + (i * 0.1);
        BatteryPack.emplace_back(i, initialTemp);
    }

    std::cout << "Starting EV Battery Thermal Simulation...\n";
    std::cout << "--------------------------------------------------------\n";

    double simTime = 0.0;
    double heatGen = 5.0;       // Internal heat generation
    double coolingPower = 0.2;  // Active cooling factor

    // Simulation loop for 1,000 steps
    for (int step = 0; step < TOTAL_STEPS; ++step) {
        
        // Print telemetry every 100 steps
        if (step % 100 == 0) {
            double sumTemp = 0.0;
            double maxTemp = BatteryPack[0].temperature();

            for (const auto& cell : BatteryPack) {
                double temp = cell.temperature();
                sumTemp += temp;
                if (temp > maxTemp) {
                    maxTemp = temp;
                }
            }

            double avgTemp = sumTemp / NUM_CELLS;

            cout << fixed << std::setprecision(2)
                 << "t=" << std::setw(5) << simTime << "s | "
                 << "cell0=" << BatteryPack[0].temperature() << "°C | "
                 << "avg=" << avgTemp << "°C | "
                 << "max=" << maxTemp << "°C\n";
        }

        // Updating physics for each individual cell in the BatteryPack
        for (auto& cell : BatteryPack) {
            cell.update(DT, heatGen, coolingPower);
        }

        simTime += DT;
    }

    std::cout << "--------------------------------------------------------\n";
    std::cout << "Simulation complete.\n";

    return 0;
}
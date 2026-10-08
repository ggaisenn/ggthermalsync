#include <algorithm>
#include <iomanip>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include "BatteryCell.h"
#include "JsonEncoder.h"
#include "PidController.h"
#include "TcpClient.h"
using namespace std;

namespace {
constexpr int NUM_CELLS = 16;
constexpr double DT = 0.016;       // Fixed timestep (~60Hz)
constexpr int TOTAL_STEPS = 1000;

struct FaultSchedule {
    optional<int> cell3ResistanceSpikeAt;
    optional<int> cell3ResistanceRecoverAt;
    optional<int> pumpJamAt;
    optional<int> pumpRecoverAt;
};

int parseStep(const std::string& value, const std::string& option) {
    if (value.empty() || value.front() == '-')
        throw std::invalid_argument(option + " requires a step from 0 to " +
                                    std::to_string(TOTAL_STEPS - 1));
    std::size_t parsedChars = 0;
    const unsigned long parsed = std::stoul(value, &parsedChars);
    if (parsedChars != value.size() || parsed >= static_cast<unsigned long>(TOTAL_STEPS))
        throw std::invalid_argument(option + " requires a step from 0 to " +
                                    std::to_string(TOTAL_STEPS - 1));
    return static_cast<int>(parsed);
}

void printUsage(const char* executable) {
    std::cout << "Usage: " << executable << " [fault options]\n"
              << "Fault options are scheduled by simulation step (0-999):\n"
              << "  --cell3-resistance-spike-at STEP   Raise Cell ID 3 heat generation 5x\n"
              << "  --cell3-resistance-recover-at STEP Restore Cell ID 3 resistance\n"
              << "  --pump-jam-at STEP                 Force fan output to 0%\n"
              << "  --pump-recover-at STEP             Clear the pump jam\n"
              << "  --help                              Show this help\n";
}

FaultSchedule parseFaultSchedule(int argc, char* argv[], bool& showHelp) {
    FaultSchedule schedule;
    for (int i = 1; i < argc; ++i) {
        const std::string option = argv[i];
        if (option == "--help") {
            showHelp = true;
            continue;
        }
        if (i + 1 >= argc)
            throw std::invalid_argument(option + " requires a step argument");
        const int step = parseStep(argv[++i], option);
        if (option == "--cell3-resistance-spike-at")
            schedule.cell3ResistanceSpikeAt = step;
        else if (option == "--cell3-resistance-recover-at")
            schedule.cell3ResistanceRecoverAt = step;
        else if (option == "--pump-jam-at")
            schedule.pumpJamAt = step;
        else if (option == "--pump-recover-at")
            schedule.pumpRecoverAt = step;
        else
            throw std::invalid_argument("Unknown option: " + option);
    }

    if (schedule.cell3ResistanceRecoverAt && !schedule.cell3ResistanceSpikeAt)
        throw std::invalid_argument("--cell3-resistance-recover-at requires --cell3-resistance-spike-at");
    if (schedule.cell3ResistanceRecoverAt &&
        *schedule.cell3ResistanceRecoverAt <= *schedule.cell3ResistanceSpikeAt)
        throw std::invalid_argument("Cell resistance recovery must occur after its spike");
    if (schedule.pumpRecoverAt && !schedule.pumpJamAt)
        throw std::invalid_argument("--pump-recover-at requires --pump-jam-at");
    if (schedule.pumpRecoverAt && *schedule.pumpRecoverAt <= *schedule.pumpJamAt)
        throw std::invalid_argument("Pump recovery must occur after its jam");
    return schedule;
}
}  // namespace

int main(int argc, char* argv[]) {
    bool showHelp = false;
    FaultSchedule faults;
    try {
        faults = parseFaultSchedule(argc, argv, showHelp);
    } catch (const std::exception& error) {
        cerr << error.what() << '\n';
        printUsage(argv[0]);
        return 2;
    }
    if (showHelp) {
        printUsage(argv[0]);
        return 0;
    }

    // A pack of 16 cells with slight initial variations (20.0°C to 21.5°C)
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
    bool pumpJammed = false;

    // Simulation loop for 1,000 steps
    for (int step = 0; step < TOTAL_STEPS; ++step) {
        if (faults.cell3ResistanceSpikeAt && step == *faults.cell3ResistanceSpikeAt) {
            batteryPack[3].setInternalResistanceMultiplier(5.0);
            cout << "FAULT: Cell ID 3 internal resistance spiked (5x) at step " << step << ".\n";
        }
        if (faults.cell3ResistanceRecoverAt && step == *faults.cell3ResistanceRecoverAt) {
            batteryPack[3].setInternalResistanceMultiplier(1.0);
            cout << "RECOVERY: Cell ID 3 internal resistance restored at step " << step << ".\n";
        }
        if (faults.pumpJamAt && step == *faults.pumpJamAt) {
            pumpJammed = true;
            cout << "FAULT: Pump jammed at step " << step << "; fan output forced to 0%.\n";
        }
        if (faults.pumpRecoverAt && step == *faults.pumpRecoverAt) {
            pumpJammed = false;
            cout << "RECOVERY: Pump jam cleared at step " << step << ".\n";
        }

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
        const double pidOutput = controller.update(avgTemp, DT);
        const double fanSpeed = pumpJammed ? 0.0 : pidOutput;
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

#include "BatteryPack.h"
#include "BatteryCell.h"
#include <algorithm>
#include <iostream>
#include <thread>
#include <chrono>
#include <random>

BatteryPack::BatteryPack(double baseTemp, double noiseRange) {
    std::mt19937 rng(42);                                  // fixed seed → reproducible
    std::uniform_real_distribution<double> noise(-noiseRange, noiseRange);
    for (int i = 0; i < NUM_CELLS; ++i)
        cells_[i] = BatteryCell(i, baseTemp + noise(rng));
}

void BatteryPack::step(double dt, double load, double fanCooling) {
    const double perCell = load / NUM_CELLS;
    for (int row = 0; row < GRID; ++row)
        for (int col = 0; col < GRID; ++col) {
            int idx = row * GRID + col;
            cells_[idx].update(dt, perCell * heatFactor(row, col), fanCooling);
        }
}

double BatteryPack::avgTemp() const {
    double sum = 0.0;
    for (const auto& c : cells_) sum += c.temperature();
    return sum / NUM_CELLS;
}

double BatteryPack::maxTemp() const {
    return std::max_element(cells_.begin(), cells_.end(),
        [](const BatteryCell& a, const BatteryCell& b) {
            return a.temperature() < b.temperature();
        })->temperature();
}

double BatteryPack::minTemp() const {   // same shape as maxTemp, reversed comparison
    return /* you write this one */ 0.0;
}

const BatteryCell& BatteryPack::cell(int row, int col) const {
    return cells_[row * GRID + col];
}

double BatteryPack::heatFactor(int row, int col) const {
    // corner = 0.9x, edge = 1.0x, interior = 1.2x heat (interior runs hottest)
    const int dEdge = std::min({row, col, GRID - 1 - row, GRID - 1 - col});
    if (dEdge > 0) return 1.2;                            // interior block (2x2)
    const int corners = (row == 0 || row == GRID - 1) + (col == 0 || col == GRID - 1);
    return corners == 2 ? 0.9 : 1.0;                      // corner vs edge
}

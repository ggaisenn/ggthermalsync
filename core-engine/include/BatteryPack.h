#pragma once
#include <array>
#include "BatteryCell.h"

class BatteryPack {
public:
    static constexpr int GRID       = 4;
    static constexpr int NUM_CELLS  = GRID * GRID;   // 16

    BatteryPack(double baseTemp, double noiseRange);

    void step(double dt, double load, double fanCooling);  // advance whole pack
    double avgTemp() const;
    double maxTemp() const;
    double minTemp() const;
    const BatteryCell& cell(int row, int col) const;    

private:
    double heatFactor(int row, int col) const;           
    std::array<BatteryCell, NUM_CELLS> cells_;
};
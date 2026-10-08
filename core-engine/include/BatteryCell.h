#pragma once
#include <iostream>

class BatteryCell {
public:
    BatteryCell() = default;
    BatteryCell(int id, double initialTemperature);  //Define the cell constructor
    int id() const;
    double temperature() const;               
    void update(double dt, double heatGen, double coolingPower);
    void setInternalResistanceMultiplier(double multiplier);
    double internalResistanceMultiplier() const;
private:
    int    id_ = 0;
    double temp_ = 25.0;
    double internalResistanceMultiplier_ = 1.0;
};

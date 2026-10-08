#pragma once
#include <iostream>

class BatteryCell {
public:
    BatteryCell() = default;
    BatteryCell(int id, double initialTemperature);  //Define the cell constructor
    int id() const;
    double temperature() const;               
    void update(double dt, double heatGen, double coolingPower);
private:
    int    id_ = 0;
    double temp_ = 25.0;
};

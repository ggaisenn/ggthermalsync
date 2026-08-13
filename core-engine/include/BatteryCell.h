#pragma once
#include <iostream>

class BatteryCell {
public:
    BatteryCell(int id, double initialTemp);  //Define the cell constructor
    int id() const;
    double temperature() const;               
    void update(double dt, double heatGen, double coolingPower);
private:
    int    id_;
    double temp_;
};
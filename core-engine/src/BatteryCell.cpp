#include "BatteryCell.h"
#include <iostream>
#include <thread>
#include <chrono>
using namespace std;

constexpr double AMBIENT_TEMPERATURE = 25.0;         // 25°C ambient temperature
constexpr double BASE_COOLING_COEFF = 0.05;   // Base cooling coefficient

BatteryCell::BatteryCell(int id, double initialTemperature)
    : id_(id), temp_(initialTemperature) {}

int BatteryCell::id() const {
    return id_;
}

double BatteryCell::temperature() const {
    return temp_;
}

void BatteryCell::update(double dt, double heatGen, double coolingPower) {

    // Effective cooling scales with additional cooling power applied
    double effectiveCoolingCoeff = BASE_COOLING_COEFF * (1.0 + coolingPower);

    // Physics equation: dT/dt = heatGen - coolingCoeff * (T - T_ambient)
    double dT_dt = heatGen - effectiveCoolingCoeff * (temp_ - AMBIENT_TEMPERATURE);

    // Euler Integration: T += dt * dT/dt
    temp_ += dt * dT_dt;
}
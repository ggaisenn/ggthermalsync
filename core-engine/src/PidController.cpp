#include "PidController.h"
#include <algorithm>
#include <cmath>

PidController::PidController(double proportionalGain,
                             double integralGain,
                             double derivativeGain)
    : kp_(proportionalGain), ki_(integralGain), kd_(derivativeGain) {}

double PidController::update(double packTemperatureC, double dt) {
    if (!std::isfinite(packTemperatureC) || !std::isfinite(dt) || dt <= 0.0)
        return output_;

    /*Positive error means the pack is hotter than the setpoint, so cooling
    demand should rise. Derivative on measurement avoids a setpoint kick. */
    const double error = packTemperatureC - SETPOINT_C;
    const double derivative = hasPreviousTemperature_ ? ((-(packTemperatureC - previousTemperature_)) / dt) : 0.0;
    const double proposedIntegral = integral_ + error * dt;
    const double unconstrained = kp_ * error + ki_ * proposedIntegral + kd_ * derivative;

    /* Integrate unless the output is saturated and this error would push it
    farther into saturation. This prevents integral windup while allowing
    the integral term to unwind when the temperature returns toward target. */
    const bool drivesPastUpperLimit = unconstrained > MAX_OUTPUT_PERCENT && error > 0.0;
    const bool drivesPastLowerLimit = unconstrained < MIN_OUTPUT_PERCENT && error < 0.0;
    if (!drivesPastUpperLimit && !drivesPastLowerLimit)
        integral_ = proposedIntegral;

    const double rawOutput = kp_ * error + ki_ * integral_ + kd_ * derivative;
    output_ = std::clamp(rawOutput, MIN_OUTPUT_PERCENT, MAX_OUTPUT_PERCENT);
    previousTemperature_ = packTemperatureC;
    hasPreviousTemperature_ = true;
    return output_;
}

void PidController::reset() {
    integral_ = 0.0;
    previousTemperature_ = 0.0;
    output_ = MIN_OUTPUT_PERCENT;
    hasPreviousTemperature_ = false;
}

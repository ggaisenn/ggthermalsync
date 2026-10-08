#pragma once

class PidController {
public:
    static constexpr double SETPOINT_C = 35.0;
    static constexpr double MIN_OUTPUT_PERCENT = 0.0;
    static constexpr double MAX_OUTPUT_PERCENT = 100.0;

    /* Gains are expressed as percent output per °C, per °C·second, and
    percent output·second per °C, respectively.*/
    PidController(double proportionalGain = 8.0,
                  double integralGain = 0.5,
                  double derivativeGain = 1.0);

    // Return the commanded fan speed in percent. dt is in seconds.
    double update(double packTemperatureC, double dt);
    void reset();

private:
    double kp_;
    double ki_;
    double kd_;
    double integral_ = 0.0;
    double previousTemperature_ = 0.0;
    double output_ = MIN_OUTPUT_PERCENT;
    bool hasPreviousTemperature_ = false;
};

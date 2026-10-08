#include "JsonEncoder.h"

#include <cmath>
#include <iomanip>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {
void requireFinite(double value, const char* field) {
    if (!std::isfinite(value))
        throw std::invalid_argument(std::string("JSON telemetry field '") + field + "' must be finite");
}
}  // namespace

std::string JsonEncoder::encode(double timestamp,
                                double tempAvg,
                                double fanSpeed,
                                const std::vector<double>& cellTemps) {
    requireFinite(timestamp, "timestamp");
    requireFinite(tempAvg, "temp_avg");
    requireFinite(fanSpeed, "fan_speed");
    for (double temperature : cellTemps)
        requireFinite(temperature, "cell_temps");

    std::ostringstream frame;
    frame.imbue(std::locale::classic());
    frame << std::setprecision(17)
          << "{\"timestamp\":" << timestamp
          << ",\"temp_avg\":" << tempAvg
          << ",\"fan_speed\":" << fanSpeed
          << ",\"cell_temps\":[";

    for (std::size_t i = 0; i < cellTemps.size(); ++i) {
        if (i != 0) frame << ',';
        frame << cellTemps[i];
    }
    frame << "]}\n";
    return frame.str();
}

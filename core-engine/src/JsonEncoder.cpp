#include "JsonEncoder.h"
#include "SafetyLimits.h"

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
                                double pidOutput,
                                double fanSpeed,
                                const std::vector<double>& cellTemps,
                                bool fanOverride) {
    requireFinite(timestamp, "timestamp");
    requireFinite(tempAvg, "temp_avg");
    requireFinite(pidOutput, "pid_output");
    requireFinite(fanSpeed, "fan_speed");
    for (double temperature : cellTemps)
        requireFinite(temperature, "cell_temps");

    std::ostringstream frame;
    frame.imbue(std::locale::classic());
    frame << std::setprecision(17)
          << "{\"timestamp\":" << timestamp
          << ",\"source\":\"core-engine\""
          << ",\"temp_avg\":" << tempAvg
          << ",\"pid_output\":" << pidOutput
          << ",\"fan_speed\":" << fanSpeed
          << ",\"fan_override\":" << (fanOverride ? "true" : "false")
          << ",\"warning_threshold\":" << WARNING_TEMP_C
          << ",\"critical_threshold\":" << CRITICAL_TEMP_C
          << ",\"cell_temps\":[";

    for (std::size_t i = 0; i < cellTemps.size(); ++i) {
        if (i != 0) frame << ',';
        frame << cellTemps[i];
    }
    frame << "]}\n";
    return frame.str();
}

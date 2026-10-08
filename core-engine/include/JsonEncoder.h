#pragma once

#include <string>
#include <vector>

class JsonEncoder {
public:
    // Encode one telemetry frame as NDJSON, including its terminating newline.
    static std::string encode(double timestamp,
                              double tempAvg,
                              double fanSpeed,
                              const std::vector<double>& cellTemps);
};

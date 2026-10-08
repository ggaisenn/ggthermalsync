#pragma once

#include <chrono>
#include <cstdint>
#include <string>

class TcpClient {
public:
    explicit TcpClient(std::string host = "127.0.0.1",
                       std::uint16_t port = 9001,
                       unsigned int connectAttempts = 3);
    ~TcpClient();

    TcpClient(const TcpClient&) = delete;
    TcpClient& operator=(const TcpClient&) = delete;

    // Send a complete NDJSON frame. Returns false if connection or sending fails.
    bool sendFrame(const std::string& frame);
    bool isConnected() const;

private:
    bool connectWithRetry();
    void closeSocket();
    void scheduleRetry();

    std::string host_;
    std::uint16_t port_;
    unsigned int connectAttempts_;
    int socket_ = -1;
    std::chrono::milliseconds retryDelay_{250};
    std::chrono::steady_clock::time_point nextRetry_{};
};

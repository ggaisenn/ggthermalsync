#include "TcpClient.h"

#include <algorithm>
#include <cerrno>
#include <netdb.h>
#include <thread>
#include <utility>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

namespace {
constexpr std::chrono::milliseconds MAX_RETRY_DELAY{30000};
}

TcpClient::TcpClient(std::string host, std::uint16_t port, unsigned int connectAttempts)
    : host_(std::move(host)), port_(port), connectAttempts_(std::max(1u, connectAttempts)) {}

TcpClient::~TcpClient() {
    closeSocket();
}

bool TcpClient::sendFrame(const std::string& frame) {
    if (socket_ < 0 && !connectWithRetry())
        return false;

    std::size_t sent = 0;
    while (sent < frame.size()) {
#if defined(MSG_NOSIGNAL)
        const ssize_t count = ::send(socket_, frame.data() + sent, frame.size() - sent, MSG_NOSIGNAL);
#else
        const ssize_t count = ::send(socket_, frame.data() + sent, frame.size() - sent, 0);
#endif
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0) {
            closeSocket();
            scheduleRetry();
            return false;
        }
        sent += static_cast<std::size_t>(count);
    }
    return true;
}

bool TcpClient::isConnected() const {
    return socket_ >= 0;
}

bool TcpClient::connectWithRetry() {
    if (std::chrono::steady_clock::now() < nextRetry_)
        return false;

    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* addresses = nullptr;
    const std::string service = std::to_string(port_);
    if (::getaddrinfo(host_.c_str(), service.c_str(), &hints, &addresses) != 0) {
        scheduleRetry();
        return false;
    }

    for (unsigned int attempt = 0; attempt < connectAttempts_; ++attempt) {
        for (const addrinfo* address = addresses; address; address = address->ai_next) {
            const int candidate = ::socket(address->ai_family, address->ai_socktype, address->ai_protocol);
            if (candidate < 0)
                continue;

#if defined(SO_NOSIGPIPE)
            int noSigPipe = 1;
            ::setsockopt(candidate, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, sizeof(noSigPipe));
#endif

            if (::connect(candidate, address->ai_addr, address->ai_addrlen) == 0) {
                socket_ = candidate;
                ::freeaddrinfo(addresses);
                retryDelay_ = std::chrono::milliseconds{250};
                nextRetry_ = {};
                return true;
            }
            ::close(candidate);
        }

        if (attempt + 1 < connectAttempts_)
            std::this_thread::sleep_for(std::chrono::milliseconds{100});
    }

    ::freeaddrinfo(addresses);
    scheduleRetry();
    return false;
}

void TcpClient::closeSocket() {
    if (socket_ >= 0) {
        ::close(socket_);
        socket_ = -1;
    }
}

void TcpClient::scheduleRetry() {
    nextRetry_ = std::chrono::steady_clock::now() + retryDelay_;
    retryDelay_ = std::min(retryDelay_ * 2, MAX_RETRY_DELAY);
}

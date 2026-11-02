#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <mutex>
#include <random>
#include <string>
#include <vector>

namespace cg {

bool netInit();

struct Address {
  uint32_t ip = 0; // host byte order IPv4
  uint16_t port = 0;

  bool operator==(const Address &o) const { return ip == o.ip && port == o.port; }
  bool operator!=(const Address &o) const { return !(*this == o); }
  bool valid() const { return port != 0; }
  std::string toString() const;
};

// Resolves "host" (name or dotted IPv4) to an address.
bool resolveAddress(const std::string &host, uint16_t port, Address &out);
// Parses "host:port" (port optional).
bool parseHostPort(const std::string &text, uint16_t defaultPort, Address &out);

class UdpSocket {
public:
  UdpSocket() = default;
  ~UdpSocket();
  UdpSocket(const UdpSocket &) = delete;
  UdpSocket &operator=(const UdpSocket &) = delete;

  // port 0 = ephemeral. Non-blocking.
  bool open(uint16_t port = 0, const std::string &bindHost = "0.0.0.0");
  void close();
  bool isOpen() const;
  uint16_t localPort() const { return localPort_; }

  bool sendTo(const Address &to, const uint8_t *data, size_t size);
  // Returns bytes received, 0 if nothing pending, -1 on error.
  int receiveFrom(Address &from, uint8_t *buffer, size_t capacity);
  // Blocks until readable or timeout. Returns true if readable.
  bool wait(int timeoutMs);

private:
#ifdef _WIN32
  uintptr_t handle_ = ~uintptr_t(0);
#else
  int handle_ = -1;
#endif
  uint16_t localPort_ = 0;
};

struct NetConditions {
  int latencyMs = 0; // added round-trip time, split evenly between both directions
  int jitterMs = 0;  // +/- random variation per packet and direction
  double lossPercent = 0;
  bool allowReorder = false;
};

// Network condition simulator wrapped around a UDP socket. Used by test clients and the server
// to emulate latency, jitter, and packet loss. Settings can be changed at any time.
class ConditionedSocket {
public:
  explicit ConditionedSocket(UdpSocket &socket, uint32_t seed = 1234);

  void setConditions(const NetConditions &conditions);
  NetConditions conditions() const;

  bool sendTo(const Address &to, const std::vector<uint8_t> &data);
  // Moves due packets in both directions; call frequently.
  void pump();
  bool receive(Address &from, std::vector<uint8_t> &data);
  int64_t nextDueMicros() const;

  struct Stats {
    uint64_t sent = 0, received = 0, droppedOut = 0, droppedIn = 0, bytesSent = 0,
             bytesReceived = 0;
  };
  Stats stats() const;

private:
  struct Pending {
    int64_t due;
    Address address;
    std::vector<uint8_t> data;
  };
  int64_t delayFor(int64_t &lastDue);
  bool lose();

  UdpSocket &socket_;
  mutable std::mutex mutex_;
  NetConditions conditions_;
  std::mt19937 rng_;
  std::deque<Pending> outgoing_;
  std::deque<Pending> incoming_;
  int64_t lastOutDue_ = 0;
  int64_t lastInDue_ = 0;
  Stats stats_;
};

} // namespace cg

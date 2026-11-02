#include "net.h"

#include <algorithm>
#include <cstring>

#include "log.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
using SocketHandle = SOCKET;
#define CG_INVALID_SOCKET INVALID_SOCKET
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
using SocketHandle = int;
#define CG_INVALID_SOCKET (-1)
#endif

namespace cg {

bool netInit() {
#ifdef _WIN32
  static bool initialized = false;
  if (!initialized) {
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return false;
    initialized = true;
  }
#endif
  return true;
}

std::string Address::toString() const {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%u.%u.%u.%u:%u", (ip >> 24) & 255, (ip >> 16) & 255,
                (ip >> 8) & 255, ip & 255, port);
  return buf;
}

bool resolveAddress(const std::string &host, uint16_t port, Address &out) {
  netInit();
  addrinfo hints{};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  addrinfo *result = nullptr;
  std::string name = host == "localhost" ? "127.0.0.1" : host;
  if (getaddrinfo(name.c_str(), nullptr, &hints, &result) != 0 || !result) return false;
  auto *sin = reinterpret_cast<sockaddr_in *>(result->ai_addr);
  out.ip = ntohl(sin->sin_addr.s_addr);
  out.port = port;
  freeaddrinfo(result);
  return true;
}

bool parseHostPort(const std::string &text, uint16_t defaultPort, Address &out) {
  std::string host = text;
  uint16_t port = defaultPort;
  size_t colon = text.rfind(':');
  if (colon != std::string::npos) {
    host = text.substr(0, colon);
    port = static_cast<uint16_t>(std::atoi(text.c_str() + colon + 1));
  }
  return resolveAddress(host, port, out);
}

UdpSocket::~UdpSocket() { close(); }

bool UdpSocket::isOpen() const {
  return static_cast<SocketHandle>(handle_) != CG_INVALID_SOCKET;
}

bool UdpSocket::open(uint16_t port, const std::string &bindHost) {
  netInit();
  close();
  SocketHandle s = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s == CG_INVALID_SOCKET) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  inet_pton(AF_INET, bindHost.c_str(), &addr.sin_addr);
  int buffer = 1 << 20;
  setsockopt(s, SOL_SOCKET, SO_RCVBUF, reinterpret_cast<const char *>(&buffer), sizeof(buffer));
  setsockopt(s, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char *>(&buffer), sizeof(buffer));
  if (::bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
#ifdef _WIN32
    closesocket(s);
#else
    ::close(s);
#endif
    return false;
  }
#ifdef _WIN32
  u_long nonBlocking = 1;
  ioctlsocket(s, FIONBIO, &nonBlocking);
  // Ignore ICMP port-unreachable resets so one vanished peer does not break the socket.
  BOOL connReset = FALSE;
  DWORD bytes = 0;
  WSAIoctl(s, _WSAIOW(IOC_VENDOR, 12), &connReset, sizeof(connReset), nullptr, 0, &bytes,
           nullptr, nullptr);
#else
  fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) | O_NONBLOCK);
#endif
  sockaddr_in bound{};
  socklen_t len = sizeof(bound);
  getsockname(s, reinterpret_cast<sockaddr *>(&bound), &len);
  localPort_ = ntohs(bound.sin_port);
#ifdef _WIN32
  handle_ = static_cast<uintptr_t>(s);
#else
  handle_ = s;
#endif
  return true;
}

void UdpSocket::close() {
  if (!isOpen()) return;
#ifdef _WIN32
  closesocket(static_cast<SOCKET>(handle_));
  handle_ = ~uintptr_t(0);
#else
  ::close(handle_);
  handle_ = -1;
#endif
}

bool UdpSocket::sendTo(const Address &to, const uint8_t *data, size_t size) {
  if (!isOpen()) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(to.port);
  addr.sin_addr.s_addr = htonl(to.ip);
  auto sent = ::sendto(static_cast<SocketHandle>(handle_), reinterpret_cast<const char *>(data),
                       static_cast<int>(size), 0, reinterpret_cast<sockaddr *>(&addr),
                       sizeof(addr));
  return sent == static_cast<decltype(sent)>(size);
}

int UdpSocket::receiveFrom(Address &from, uint8_t *buffer, size_t capacity) {
  if (!isOpen()) return -1;
  sockaddr_in addr{};
  socklen_t len = sizeof(addr);
  auto received =
      ::recvfrom(static_cast<SocketHandle>(handle_), reinterpret_cast<char *>(buffer),
                 static_cast<int>(capacity), 0, reinterpret_cast<sockaddr *>(&addr), &len);
  if (received < 0) {
#ifdef _WIN32
    int error = WSAGetLastError();
    if (error == WSAEWOULDBLOCK || error == WSAECONNRESET || error == WSAEMSGSIZE) return 0;
#else
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == ECONNREFUSED) return 0;
#endif
    return -1;
  }
  from.ip = ntohl(addr.sin_addr.s_addr);
  from.port = ntohs(addr.sin_port);
  return static_cast<int>(received);
}

bool UdpSocket::wait(int timeoutMs) {
  if (!isOpen()) return false;
  fd_set set;
  FD_ZERO(&set);
  SocketHandle s = static_cast<SocketHandle>(handle_);
  FD_SET(s, &set);
  timeval tv;
  tv.tv_sec = timeoutMs / 1000;
  tv.tv_usec = (timeoutMs % 1000) * 1000;
  return ::select(static_cast<int>(s + 1), &set, nullptr, nullptr, &tv) > 0;
}

ConditionedSocket::ConditionedSocket(UdpSocket &socket, uint32_t seed)
    : socket_(socket), rng_(seed) {}

void ConditionedSocket::setConditions(const NetConditions &conditions) {
  std::lock_guard<std::mutex> lock(mutex_);
  conditions_ = conditions;
  conditions_.latencyMs = std::max(0, conditions_.latencyMs);
  conditions_.jitterMs = std::max(0, conditions_.jitterMs);
  conditions_.lossPercent = std::max(0.0, std::min(100.0, conditions_.lossPercent));
}

NetConditions ConditionedSocket::conditions() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return conditions_;
}

ConditionedSocket::Stats ConditionedSocket::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return stats_;
}

int64_t ConditionedSocket::delayFor(int64_t &lastDue) {
  int64_t delay = static_cast<int64_t>(conditions_.latencyMs) * 1000 / 2;
  if (conditions_.jitterMs > 0) {
    std::uniform_int_distribution<int> jitter(-conditions_.jitterMs * 1000,
                                              conditions_.jitterMs * 1000);
    delay += jitter(rng_);
  }
  int64_t due = nowMicros() + std::max<int64_t>(0, delay);
  // Without reordering, a packet never overtakes the previous one.
  if (!conditions_.allowReorder) due = std::max(due, lastDue);
  lastDue = due;
  return due;
}

bool ConditionedSocket::lose() {
  if (conditions_.lossPercent <= 0) return false;
  std::uniform_real_distribution<double> roll(0, 100);
  return roll(rng_) < conditions_.lossPercent;
}

bool ConditionedSocket::sendTo(const Address &to, const std::vector<uint8_t> &data) {
  std::lock_guard<std::mutex> lock(mutex_);
  stats_.sent++;
  stats_.bytesSent += data.size();
  if (lose()) {
    stats_.droppedOut++;
    return true;
  }
  if (conditions_.latencyMs == 0 && conditions_.jitterMs == 0 && outgoing_.empty())
    return socket_.sendTo(to, data.data(), data.size());
  Pending p{delayFor(lastOutDue_), to, data};
  auto it = std::upper_bound(outgoing_.begin(), outgoing_.end(), p.due,
                             [](int64_t due, const Pending &q) { return due < q.due; });
  outgoing_.insert(it, std::move(p));
  return true;
}

void ConditionedSocket::pump() {
  std::lock_guard<std::mutex> lock(mutex_);
  int64_t now = nowMicros();
  while (!outgoing_.empty() && outgoing_.front().due <= now) {
    auto &p = outgoing_.front();
    socket_.sendTo(p.address, p.data.data(), p.data.size());
    outgoing_.pop_front();
  }
  uint8_t buffer[2048];
  Address from;
  int n;
  while ((n = socket_.receiveFrom(from, buffer, sizeof(buffer))) > 0) {
    stats_.received++;
    stats_.bytesReceived += static_cast<uint64_t>(n);
    if (lose()) {
      stats_.droppedIn++;
      continue;
    }
    Pending p{delayFor(lastInDue_), from, std::vector<uint8_t>(buffer, buffer + n)};
    auto it = std::upper_bound(incoming_.begin(), incoming_.end(), p.due,
                               [](int64_t due, const Pending &q) { return due < q.due; });
    incoming_.insert(it, std::move(p));
  }
}

bool ConditionedSocket::receive(Address &from, std::vector<uint8_t> &data) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (incoming_.empty() || incoming_.front().due > nowMicros()) return false;
  from = incoming_.front().address;
  data = std::move(incoming_.front().data);
  incoming_.pop_front();
  return true;
}

int64_t ConditionedSocket::nextDueMicros() const {
  std::lock_guard<std::mutex> lock(mutex_);
  int64_t next = INT64_MAX;
  if (!outgoing_.empty()) next = std::min(next, outgoing_.front().due);
  if (!incoming_.empty()) next = std::min(next, incoming_.front().due);
  return next;
}

} // namespace cg

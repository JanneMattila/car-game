#include "http.h"

#include <cstdlib>
#include <cstring>

#include "log.h"
#include "net.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
using TcpHandle = SOCKET;
#define CG_BAD_TCP INVALID_SOCKET
#define cg_closesocket closesocket
#else
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
using TcpHandle = int;
#define CG_BAD_TCP (-1)
#define cg_closesocket ::close
#endif

namespace cg {

HttpClient::HttpClient(std::string baseUrl, int timeoutMs) : timeoutMs_(timeoutMs) {
  const std::string prefix = "http://";
  if (baseUrl.compare(0, prefix.size(), prefix) != 0) return;
  std::string rest = baseUrl.substr(prefix.size());
  size_t slash = rest.find('/');
  std::string authority = rest.substr(0, slash);
  basePath_ = slash == std::string::npos ? "" : rest.substr(slash);
  while (!basePath_.empty() && basePath_.back() == '/') basePath_.pop_back();
  size_t colon = authority.rfind(':');
  if (colon != std::string::npos) {
    host_ = authority.substr(0, colon);
    port_ = std::atoi(authority.c_str() + colon + 1);
  } else {
    host_ = authority;
  }
  valid_ = !host_.empty() && port_ > 0;
}

HttpResponse HttpClient::get(const std::string &path) const { return request("GET", path, ""); }
HttpResponse HttpClient::post(const std::string &path, const std::string &body) const {
  return request("POST", path, body);
}
HttpResponse HttpClient::put(const std::string &path, const std::string &body) const {
  return request("PUT", path, body);
}

namespace {
std::string decodeChunked(const std::string &body) {
  std::string out;
  size_t pos = 0;
  while (pos < body.size()) {
    size_t lineEnd = body.find("\r\n", pos);
    if (lineEnd == std::string::npos) break;
    size_t size = std::strtoul(body.substr(pos, lineEnd - pos).c_str(), nullptr, 16);
    pos = lineEnd + 2;
    if (size == 0) break;
    out.append(body, pos, size);
    pos += size + 2;
  }
  return out;
}
} // namespace

HttpResponse HttpClient::request(const std::string &method, const std::string &path,
                                 const std::string &body) const {
  HttpResponse response;
  if (!valid_) {
    response.error = "invalid base URL";
    return response;
  }
  netInit();
  addrinfo hints{};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo *addrs = nullptr;
  std::string host = host_ == "localhost" ? "127.0.0.1" : host_;
  if (getaddrinfo(host.c_str(), std::to_string(port_).c_str(), &hints, &addrs) != 0 || !addrs) {
    response.error = "cannot resolve " + host_;
    return response;
  }
  TcpHandle s = ::socket(addrs->ai_family, addrs->ai_socktype, addrs->ai_protocol);
  if (s == CG_BAD_TCP) {
    freeaddrinfo(addrs);
    response.error = "socket failed";
    return response;
  }
#ifdef _WIN32
  DWORD tv = static_cast<DWORD>(timeoutMs_);
#else
  timeval tv{timeoutMs_ / 1000, (timeoutMs_ % 1000) * 1000};
#endif
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&tv), sizeof(tv));
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char *>(&tv), sizeof(tv));
  if (::connect(s, addrs->ai_addr, static_cast<int>(addrs->ai_addrlen)) != 0) {
    freeaddrinfo(addrs);
    cg_closesocket(s);
    response.error = "cannot connect to " + host_ + ":" + std::to_string(port_);
    return response;
  }
  freeaddrinfo(addrs);

  std::string req = method + " " + basePath_ + path + " HTTP/1.1\r\nHost: " + host_ + ":" +
                    std::to_string(port_) +
                    "\r\nUser-Agent: car-game-native\r\nAccept: application/json\r\n"
                    "Connection: close\r\n";
  if (method != "GET") {
    req += "Content-Type: application/json\r\nContent-Length: " + std::to_string(body.size()) +
           "\r\n";
  }
  req += "\r\n" + body;
  size_t sent = 0;
  while (sent < req.size()) {
    int n = ::send(s, req.data() + sent, static_cast<int>(req.size() - sent), 0);
    if (n <= 0) {
      cg_closesocket(s);
      response.error = "send failed";
      return response;
    }
    sent += static_cast<size_t>(n);
  }
  std::string raw;
  char buffer[8192];
  for (;;) {
    int n = ::recv(s, buffer, sizeof(buffer), 0);
    if (n <= 0) break;
    raw.append(buffer, static_cast<size_t>(n));
  }
  cg_closesocket(s);

  size_t headerEnd = raw.find("\r\n\r\n");
  if (raw.compare(0, 5, "HTTP/") != 0 || headerEnd == std::string::npos) {
    response.error = raw.empty() ? "no response (timeout)" : "malformed response";
    return response;
  }
  size_t space = raw.find(' ');
  response.status = std::atoi(raw.c_str() + space + 1);
  std::string headers = raw.substr(0, headerEnd);
  for (auto &c : headers) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  response.body = raw.substr(headerEnd + 4);
  if (headers.find("transfer-encoding: chunked") != std::string::npos)
    response.body = decodeChunked(response.body);
  return response;
}

std::string urlEncode(const std::string &text) {
  static const char *hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : text) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out += static_cast<char>(c);
    } else {
      out += '%';
      out += hex[c >> 4];
      out += hex[c & 15];
    }
  }
  return out;
}

} // namespace cg

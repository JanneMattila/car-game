#pragma once

#include <string>

namespace cg {

struct HttpResponse {
  int status = 0; // 0 = transport error
  std::string body;
  std::string error;
  bool ok() const { return status >= 200 && status < 300; }
};

// Minimal blocking HTTP/1.1 client (plain http only) used to talk to the lobby REST API.
// baseUrl example: "http://localhost:3000".
class HttpClient {
public:
  explicit HttpClient(std::string baseUrl, int timeoutMs = 5000);

  HttpResponse get(const std::string &path) const;
  HttpResponse post(const std::string &path, const std::string &jsonBody) const;
  HttpResponse put(const std::string &path, const std::string &jsonBody) const;
  HttpResponse request(const std::string &method, const std::string &path,
                       const std::string &body) const;

  const std::string &host() const { return host_; }
  int port() const { return port_; }
  bool valid() const { return valid_; }

private:
  std::string host_;
  int port_ = 80;
  std::string basePath_;
  int timeoutMs_;
  bool valid_ = false;
};

std::string urlEncode(const std::string &text);

} // namespace cg

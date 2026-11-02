#include "json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace cg {

namespace {

const Json kNull;

class Parser {
public:
  explicit Parser(std::string_view text) : text_(text) {}

  bool parse(Json &out, std::string *error) {
    skipSpace();
    if (!value(out, 0)) {
      if (error) *error = error_ + " at offset " + std::to_string(pos_);
      return false;
    }
    skipSpace();
    if (pos_ != text_.size()) {
      if (error) *error = "trailing characters at offset " + std::to_string(pos_);
      return false;
    }
    return true;
  }

private:
  void skipSpace() {
    while (pos_ < text_.size() &&
           (text_[pos_] == ' ' || text_[pos_] == '\n' || text_[pos_] == '\r' ||
            text_[pos_] == '\t'))
      ++pos_;
  }

  bool fail(const char *message) {
    error_ = message;
    return false;
  }

  bool literal(std::string_view word) {
    if (text_.substr(pos_, word.size()) != word) return false;
    pos_ += word.size();
    return true;
  }

  bool value(Json &out, int depth) {
    if (depth > 200) return fail("nesting too deep");
    if (pos_ >= text_.size()) return fail("unexpected end");
    char c = text_[pos_];
    if (c == '{') return object(out, depth);
    if (c == '[') return array(out, depth);
    if (c == '"') {
      std::string s;
      if (!string(s)) return false;
      out = Json(std::move(s));
      return true;
    }
    if (literal("true")) {
      out = Json(true);
      return true;
    }
    if (literal("false")) {
      out = Json(false);
      return true;
    }
    if (literal("null")) {
      out = Json();
      return true;
    }
    return number(out);
  }

  bool number(Json &out) {
    size_t start = pos_;
    if (pos_ < text_.size() && (text_[pos_] == '-' || text_[pos_] == '+')) ++pos_;
    while (pos_ < text_.size()) {
      char c = text_[pos_];
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+')
        ++pos_;
      else
        break;
    }
    if (start == pos_) return fail("unexpected character");
    std::string token(text_.substr(start, pos_ - start));
    char *end = nullptr;
    double v = std::strtod(token.c_str(), &end);
    if (!end || *end != '\0') return fail("invalid number");
    out = Json(v);
    return true;
  }

  static void appendUtf8(std::string &s, uint32_t cp) {
    if (cp < 0x80) {
      s += static_cast<char>(cp);
    } else if (cp < 0x800) {
      s += static_cast<char>(0xC0 | (cp >> 6));
      s += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      s += static_cast<char>(0xE0 | (cp >> 12));
      s += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      s += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      s += static_cast<char>(0xF0 | (cp >> 18));
      s += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      s += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      s += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }

  bool hex4(uint32_t &cp) {
    if (pos_ + 4 > text_.size()) return fail("bad escape");
    cp = 0;
    for (int i = 0; i < 4; ++i) {
      char c = text_[pos_++];
      cp <<= 4;
      if (c >= '0' && c <= '9') cp |= c - '0';
      else if (c >= 'a' && c <= 'f') cp |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') cp |= c - 'A' + 10;
      else return fail("bad escape");
    }
    return true;
  }

  bool string(std::string &out) {
    ++pos_;
    while (pos_ < text_.size()) {
      char c = text_[pos_++];
      if (c == '"') return true;
      if (c != '\\') {
        out += c;
        continue;
      }
      if (pos_ >= text_.size()) break;
      char e = text_[pos_++];
      switch (e) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u': {
        uint32_t cp = 0;
        if (!hex4(cp)) return false;
        if (cp >= 0xD800 && cp < 0xDC00 && pos_ + 6 <= text_.size() && text_[pos_] == '\\' &&
            text_[pos_ + 1] == 'u') {
          pos_ += 2;
          uint32_t low = 0;
          if (!hex4(low)) return false;
          cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
        }
        appendUtf8(out, cp);
        break;
      }
      default: return fail("bad escape");
      }
    }
    return fail("unterminated string");
  }

  bool array(Json &out, int depth) {
    ++pos_;
    out = Json::array();
    skipSpace();
    if (pos_ < text_.size() && text_[pos_] == ']') {
      ++pos_;
      return true;
    }
    while (true) {
      Json item;
      skipSpace();
      if (!value(item, depth + 1)) return false;
      out.push(std::move(item));
      skipSpace();
      if (pos_ >= text_.size()) return fail("unterminated array");
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == ']') {
        ++pos_;
        return true;
      }
      return fail("expected , or ]");
    }
  }

  bool object(Json &out, int depth) {
    ++pos_;
    out = Json::object();
    skipSpace();
    if (pos_ < text_.size() && text_[pos_] == '}') {
      ++pos_;
      return true;
    }
    while (true) {
      skipSpace();
      if (pos_ >= text_.size() || text_[pos_] != '"') return fail("expected key");
      std::string key;
      if (!string(key)) return false;
      skipSpace();
      if (pos_ >= text_.size() || text_[pos_] != ':') return fail("expected :");
      ++pos_;
      skipSpace();
      Json item;
      if (!value(item, depth + 1)) return false;
      out.set(key, std::move(item));
      skipSpace();
      if (pos_ >= text_.size()) return fail("unterminated object");
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == '}') {
        ++pos_;
        return true;
      }
      return fail("expected , or }");
    }
  }

  std::string_view text_;
  size_t pos_ = 0;
  std::string error_;
};

} // namespace

Json Json::parse(std::string_view text, std::string *error) {
  Json out;
  Parser parser(text);
  if (!parser.parse(out, error)) return Json();
  return out;
}

bool Json::has(std::string_view key) const {
  for (const auto &m : members_)
    if (m.first == key) return true;
  return false;
}

const Json &Json::operator[](std::string_view key) const {
  for (const auto &m : members_)
    if (m.first == key) return m.second;
  return kNull;
}

const Json &Json::operator[](size_t index) const {
  return index < items_.size() ? items_[index] : kNull;
}

size_t Json::size() const {
  if (type_ == Type::Array) return items_.size();
  if (type_ == Type::Object) return members_.size();
  return 0;
}

Json &Json::set(const std::string &key, Json value) {
  type_ = Type::Object;
  for (auto &m : members_) {
    if (m.first == key) {
      m.second = std::move(value);
      return *this;
    }
  }
  members_.emplace_back(key, std::move(value));
  return *this;
}

Json &Json::push(Json value) {
  type_ = Type::Array;
  items_.push_back(std::move(value));
  return *this;
}

std::string jsonEscape(std::string_view text) {
  std::string out = "\"";
  for (char c : text) {
    switch (c) {
    case '"': out += "\\\""; break;
    case '\\': out += "\\\\"; break;
    case '\n': out += "\\n"; break;
    case '\r': out += "\\r"; break;
    case '\t': out += "\\t"; break;
    default:
      if (static_cast<unsigned char>(c) < 0x20) {
        char buf[8];
        std::snprintf(buf, sizeof(buf), "\\u%04x", c);
        out += buf;
      } else {
        out += c;
      }
    }
  }
  out += '"';
  return out;
}

void Json::dumpTo(std::string &out) const {
  switch (type_) {
  case Type::Null: out += "null"; break;
  case Type::Bool: out += bool_ ? "true" : "false"; break;
  case Type::Number: {
    if (!std::isfinite(number_)) {
      out += "null";
    } else if (number_ == std::floor(number_) && std::fabs(number_) < 1e15) {
      out += std::to_string(static_cast<long long>(number_));
    } else {
      char buf[32];
      std::snprintf(buf, sizeof(buf), "%.10g", number_);
      out += buf;
    }
    break;
  }
  case Type::String: out += jsonEscape(string_); break;
  case Type::Array:
    out += '[';
    for (size_t i = 0; i < items_.size(); ++i) {
      if (i) out += ',';
      items_[i].dumpTo(out);
    }
    out += ']';
    break;
  case Type::Object:
    out += '{';
    for (size_t i = 0; i < members_.size(); ++i) {
      if (i) out += ',';
      out += jsonEscape(members_[i].first);
      out += ':';
      members_[i].second.dumpTo(out);
    }
    out += '}';
    break;
  }
}

std::string Json::dump() const {
  std::string out;
  dumpTo(out);
  return out;
}

} // namespace cg

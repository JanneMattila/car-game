#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace cg {

// Small JSON DOM used for track files, match configuration, and the lobby REST API.
class Json {
public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool value) : type_(Type::Bool), bool_(value) {}
  Json(int value) : type_(Type::Number), number_(value) {}
  Json(int64_t value) : type_(Type::Number), number_(static_cast<double>(value)) {}
  Json(uint32_t value) : type_(Type::Number), number_(value) {}
  Json(double value) : type_(Type::Number), number_(value) {}
  Json(const char *value) : type_(Type::String), string_(value) {}
  Json(std::string value) : type_(Type::String), string_(std::move(value)) {}

  static Json array() {
    Json json;
    json.type_ = Type::Array;
    return json;
  }
  static Json object() {
    Json json;
    json.type_ = Type::Object;
    return json;
  }

  // Returns a Null value and fills error when the text is not valid JSON.
  static Json parse(std::string_view text, std::string *error = nullptr);
  std::string dump() const;

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isBool() const { return type_ == Type::Bool; }
  bool isNumber() const { return type_ == Type::Number; }
  bool isString() const { return type_ == Type::String; }
  bool isArray() const { return type_ == Type::Array; }
  bool isObject() const { return type_ == Type::Object; }

  double number(double fallback = 0) const { return isNumber() ? number_ : fallback; }
  int integer(int fallback = 0) const {
    return isNumber() ? static_cast<int>(number_) : fallback;
  }
  bool boolean(bool fallback = false) const { return isBool() ? bool_ : fallback; }
  std::string string(const std::string &fallback = "") const {
    return isString() ? string_ : fallback;
  }

  bool has(std::string_view key) const;
  // Missing keys and out-of-range indices yield a shared Null value.
  const Json &operator[](std::string_view key) const;
  const Json &operator[](size_t index) const;
  size_t size() const;

  const std::vector<Json> &items() const { return items_; }
  const std::vector<std::pair<std::string, Json>> &members() const { return members_; }

  Json &set(const std::string &key, Json value);
  Json &push(Json value);

private:
  void dumpTo(std::string &out) const;

  Type type_ = Type::Null;
  bool bool_ = false;
  double number_ = 0;
  std::string string_;
  std::vector<Json> items_;
  std::vector<std::pair<std::string, Json>> members_;
};

std::string jsonEscape(std::string_view text);

} // namespace cg

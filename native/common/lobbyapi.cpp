#include "lobbyapi.h"

#include "log.h"

namespace cg {

LobbyApi::LobbyApi(const std::string &baseUrl) : baseUrl_(baseUrl), http_(baseUrl, 5000) {}

bool LobbyApi::call(const std::string &method, const std::string &path, const Json &body,
                    Json &out) {
  HttpResponse response = http_.request(method, path, method == "GET" ? "" : body.dump());
  if (response.status == 0) {
    error_ = response.error;
    CG_WARN("%s %s failed: %s", method.c_str(), path.c_str(), error_.c_str());
    return false;
  }
  std::string parseError;
  out = Json::parse(response.body, &parseError);
  if (!response.ok()) {
    error_ = out["error"].string(out["message"].string("HTTP " + std::to_string(response.status)));
    CG_DEBUG("%s %s -> %d %s", method.c_str(), path.c_str(), response.status, error_.c_str());
    return false;
  }
  if (!parseError.empty()) {
    error_ = "invalid JSON from server: " + parseError;
    return false;
  }
  error_.clear();
  return true;
}

namespace {
Profile parseProfile(const Json &json) {
  return {json["id"].string(), json["nickname"].string(), json["color"].string("red")};
}
} // namespace

bool LobbyApi::createProfile(const std::string &nickname, const std::string &color, Profile &out) {
  Json body = Json::object();
  body.set("nickname", nickname);
  body.set("color", color);
  Json json;
  if (!call("POST", "/api/profiles", body, json)) return false;
  out = parseProfile(json);
  return !out.id.empty();
}

bool LobbyApi::getProfile(const std::string &id, Profile &out) {
  Json json;
  if (!call("GET", "/api/profiles/" + urlEncode(id), Json(), json)) return false;
  out = parseProfile(json);
  return !out.id.empty();
}

bool LobbyApi::updateProfile(const Profile &profile) {
  Json body = Json::object();
  body.set("nickname", profile.nickname);
  body.set("color", profile.color);
  Json json;
  return call("PUT", "/api/profiles/" + urlEncode(profile.id), body, json);
}

bool LobbyApi::listTracks(std::vector<TrackInfo> &out) {
  Json json;
  if (!call("GET", "/api/tracks", Json(), json)) return false;
  out.clear();
  for (const Json &t : json.items()) out.push_back({t["id"].string(), t["name"].string("Track")});
  return true;
}

std::shared_ptr<const Track> LobbyApi::getTrack(const std::string &id) {
  Json json;
  if (!call("GET", "/api/tracks/" + urlEncode(id), Json(), json)) return nullptr;
  auto track = std::make_shared<Track>();
  std::string error;
  if (!loadTrack(json, *track, &error)) {
    error_ = "invalid track: " + error;
    return nullptr;
  }
  return track;
}

bool parseLobby(const Json &json, Lobby &out) {
  if (!json.isObject()) return false;
  out = Lobby{};
  out.id = json["id"].string();
  out.name = json["name"].string();
  out.hostId = json["hostId"].string();
  out.trackId = json["trackId"].string();
  out.trackName = json["trackName"].string(out.trackId);
  out.lapCount = json["lapCount"].integer(3);
  out.botCount = json["botCount"].integer(0);
  out.status = json["status"].string("waiting");
  out.message = json["message"].string();
  for (const Json &p : json["players"].items())
    out.players.push_back({p["profileId"].string(), p["nickname"].string(), p["color"].string(),
                           p["ready"].boolean()});
  for (const Json &r : json["lastResult"]["results"].items()) {
    LobbyResultEntry e;
    e.nickname = r["nickname"].string();
    e.position = r["position"].integer();
    e.finished = r["finished"].boolean();
    e.totalMs = static_cast<uint32_t>(r["totalMs"].number());
    e.bestLapMs = static_cast<uint32_t>(r["bestLapMs"].number());
    e.isBot = r["isBot"].boolean();
    out.lastResults.push_back(e);
  }
  const Json &c = json["connection"];
  if (c.isObject()) {
    out.hasConnection = true;
    out.connection.host = c["host"].string();
    out.connection.port = c["port"].integer();
    out.connection.token = c["token"].string();
    out.connection.matchId = c["matchId"].string();
  }
  return !out.id.empty();
}

bool LobbyApi::listLobbies(std::vector<Lobby> &out) {
  Json json;
  if (!call("GET", "/api/native/lobbies", Json(), json)) return false;
  out.clear();
  for (const Json &l : json.items()) {
    Lobby lobby;
    if (parseLobby(l, lobby)) out.push_back(lobby);
  }
  return true;
}

bool LobbyApi::createLobby(const std::string &profileId, const std::string &trackId, int lapCount,
                           int botCount, Lobby &out) {
  Json body = Json::object();
  body.set("profileId", profileId);
  body.set("trackId", trackId);
  body.set("lapCount", lapCount);
  body.set("botCount", botCount);
  Json json;
  return call("POST", "/api/native/lobbies", body, json) && parseLobby(json, out);
}

bool LobbyApi::getLobby(const std::string &lobbyId, const std::string &profileId, Lobby &out) {
  Json json;
  return call("GET",
              "/api/native/lobbies/" + urlEncode(lobbyId) + "?profileId=" + urlEncode(profileId),
              Json(), json) &&
         parseLobby(json, out);
}

bool LobbyApi::joinLobby(const std::string &lobbyId, const std::string &profileId, Lobby &out) {
  Json body = Json::object();
  body.set("profileId", profileId);
  Json json;
  return call("POST", "/api/native/lobbies/" + urlEncode(lobbyId) + "/join", body, json) &&
         parseLobby(json, out);
}

bool LobbyApi::leaveLobby(const std::string &lobbyId, const std::string &profileId) {
  Json body = Json::object();
  body.set("profileId", profileId);
  Json json;
  return call("POST", "/api/native/lobbies/" + urlEncode(lobbyId) + "/leave", body, json);
}

bool LobbyApi::setReady(const std::string &lobbyId, const std::string &profileId, bool ready) {
  Json body = Json::object();
  body.set("profileId", profileId);
  body.set("ready", ready);
  Json json;
  return call("POST", "/api/native/lobbies/" + urlEncode(lobbyId) + "/ready", body, json);
}

bool LobbyApi::updateSettings(const std::string &lobbyId, const std::string &profileId,
                              const std::string &trackId, int lapCount, int botCount) {
  Json body = Json::object();
  body.set("profileId", profileId);
  if (!trackId.empty()) body.set("trackId", trackId);
  if (lapCount > 0) body.set("lapCount", lapCount);
  if (botCount >= 0) body.set("botCount", botCount);
  Json json;
  return call("POST", "/api/native/lobbies/" + urlEncode(lobbyId) + "/settings", body, json);
}

bool LobbyApi::startLobby(const std::string &lobbyId, const std::string &profileId) {
  Json body = Json::object();
  body.set("profileId", profileId);
  Json json;
  return call("POST", "/api/native/lobbies/" + urlEncode(lobbyId) + "/start", body, json);
}

} // namespace cg

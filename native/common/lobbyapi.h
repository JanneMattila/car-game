#pragma once

#include <memory>
#include <string>
#include <vector>

#include "http.h"
#include "json.h"
#include "track.h"

namespace cg {

struct Profile {
  std::string id;
  std::string nickname;
  std::string color;
};

struct TrackInfo {
  std::string id;
  std::string name;
};

struct LobbyPlayer {
  std::string profileId;
  std::string nickname;
  std::string color;
  bool ready = false;
};

struct LobbyConnection {
  std::string host;
  int port = 0;
  std::string token;
  std::string matchId;
};

struct LobbyResultEntry {
  std::string nickname;
  int position = 0;
  bool finished = false;
  uint32_t totalMs = 0;
  uint32_t bestLapMs = 0;
  bool isBot = false;
};

struct Lobby {
  std::string id;
  std::string name;
  std::string hostId;
  std::string trackId;
  std::string trackName;
  int lapCount = 3;
  int botCount = 0;
  std::string status; // waiting | starting | running
  std::string message;
  std::vector<LobbyPlayer> players;
  std::vector<LobbyResultEntry> lastResults;
  bool hasConnection = false;
  LobbyConnection connection;
};

// Client for the web server's profile, track, and native lobby REST API.
class LobbyApi {
public:
  explicit LobbyApi(const std::string &baseUrl);

  const std::string &lastError() const { return error_; }
  const std::string &baseUrl() const { return baseUrl_; }
  std::string serverHost() const { return http_.host(); }

  bool createProfile(const std::string &nickname, const std::string &color, Profile &out);
  bool getProfile(const std::string &id, Profile &out);
  bool updateProfile(const Profile &profile);

  bool listTracks(std::vector<TrackInfo> &out);
  std::shared_ptr<const Track> getTrack(const std::string &id);

  bool listLobbies(std::vector<Lobby> &out);
  bool createLobby(const std::string &profileId, const std::string &trackId, int lapCount,
                   int botCount, Lobby &out);
  bool getLobby(const std::string &lobbyId, const std::string &profileId, Lobby &out);
  bool joinLobby(const std::string &lobbyId, const std::string &profileId, Lobby &out);
  bool leaveLobby(const std::string &lobbyId, const std::string &profileId);
  bool setReady(const std::string &lobbyId, const std::string &profileId, bool ready);
  bool updateSettings(const std::string &lobbyId, const std::string &profileId,
                      const std::string &trackId, int lapCount, int botCount);
  bool startLobby(const std::string &lobbyId, const std::string &profileId);

private:
  bool call(const std::string &method, const std::string &path, const Json &body, Json &out);

  std::string baseUrl_;
  HttpClient http_;
  std::string error_;
};

bool parseLobby(const Json &json, Lobby &out);

} // namespace cg

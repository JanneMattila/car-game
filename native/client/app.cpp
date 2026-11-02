#include "app.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <sstream>

#include "../common/json.h"
#include "../common/log.h"

namespace cgc {

using namespace cg;

namespace {

struct CarColor {
  const char *name;
  uint32_t rgb;
};
const CarColor kColors[] = {
    {"red", 0xDC2626},    {"blue", 0x1E40AF},  {"black", 0x171717}, {"white", 0xF5F5F4},
    {"silver", 0x9CA3AF}, {"green", 0x15803D}, {"yellow", 0xEAB308}, {"orange", 0xEA580C},
};
constexpr int kColorCount = static_cast<int>(sizeof(kColors) / sizeof(kColors[0]));

int colorIndexOf(const std::string &name) {
  for (int i = 0; i < kColorCount; ++i)
    if (name == kColors[i].name) return i;
  return 0;
}

std::wstring wfmt(const wchar_t *format, ...) {
  wchar_t buffer[1024];
  va_list args;
  va_start(args, format);
  std::vswprintf(buffer, 1024, format, args);
  va_end(args);
  return buffer;
}

std::wstring fmtTime(uint32_t ms) {
  return wfmt(L"%u:%02u.%03u", ms / 60000, (ms / 1000) % 60, ms % 1000);
}

std::wstring fmtTimeOrDash(uint32_t ms) { return ms ? fmtTime(ms) : L"--:--.---"; }

bool validNickname(const std::wstring &nick) {
  if (nick.size() < 2 || nick.size() > 16) return false;
  for (wchar_t c : nick) {
    bool ok = (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') ||
              c == L'_' || c == L'-';
    if (!ok) return false;
  }
  return true;
}

std::string lower(std::string text) {
  for (char &c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return text;
}

constexpr uint32_t kPanel = rgba(12, 18, 28, 190);
constexpr uint32_t kPanelSolid = rgba(22, 32, 46, 235);
constexpr uint32_t kText = rgba(236, 240, 244);
constexpr uint32_t kDim = rgba(150, 162, 176);
constexpr uint32_t kAccent = rgba(250, 204, 21);
constexpr uint32_t kGood = rgba(74, 222, 128);
constexpr uint32_t kBad = rgba(248, 113, 113);
constexpr uint32_t kSelect = rgba(56, 89, 138, 230);

} // namespace

// ---------------------------------------------------------------------------------------------
// Command line

bool parseArgs(const std::vector<std::string> &args, Config &c, std::string &error) {
  for (size_t i = 0; i < args.size(); ++i) {
    const std::string &a = args[i];
    bool missing = false;
    auto next = [&]() -> std::string {
      if (i + 1 < args.size()) return args[++i];
      missing = true;
      return {};
    };
    if (a == "--api") c.api = next();
    else if (a == "--nickname") c.nickname = next();
    else if (a == "--color") c.color = lower(next());
    else if (a == "--ai") c.ai = true;
    else if (a == "--latency") c.conditions.latencyMs = std::atoi(next().c_str());
    else if (a == "--jitter") c.conditions.jitterMs = std::atoi(next().c_str());
    else if (a == "--loss") c.conditions.lossPercent = std::atof(next().c_str());
    else if (a == "--server") c.server = next();
    else if (a == "--token") c.token = next();
    else if (a == "--track-file") c.trackFile = next();
    else if (a == "--join-any") c.joinAny = true;
    else if (a == "--create") c.createTrack = next();
    else if (a == "--auto-ready") c.autoReady = true;
    else if (a == "--start-when") c.startWhen = std::atoi(next().c_str());
    else if (a == "--laps") c.laps = std::clamp(std::atoi(next().c_str()), 1, 20);
    else if (a == "--bots") c.bots = std::clamp(std::atoi(next().c_str()), 0, 7);
    else if (a == "--exit-after-race") c.exitAfterRace = true;
    else if (a == "--log-file") c.logFile = next();
    else if (a == "--log-level") c.logLevel = next();
    else if (a == "--profile-file") c.profileFile = next();
    else {
      error = "unknown argument: " + a;
      return false;
    }
    if (missing) {
      error = "missing value for " + a;
      return false;
    }
  }
  if (!c.server.empty() && c.token.empty()) {
    error = "--token is required with --server";
    return false;
  }
  if (!c.nickname.empty() && !validNickname(widen(c.nickname))) {
    error = "nickname must be 2-16 characters of a-z, A-Z, 0-9, _ or -";
    return false;
  }
  return true;
}

std::string usageText() {
  return "cg_client [options]\n"
         "  --api URL            web server (default http://localhost:3000)\n"
         "  --nickname N         profile nickname (skips the profile screen)\n"
         "  --color C            red|blue|black|white|silver|green|yellow|orange\n"
         "  --join-any           join the first waiting lobby\n"
         "  --create TRACK_ID    create a lobby on the given track\n"
         "  --laps N --bots N    settings for --create\n"
         "  --auto-ready         mark ready automatically in the lobby\n"
         "  --start-when N       as host, start once N players are ready\n"
         "  --ai                 start with the AI autopilot (F9 toggles)\n"
         "  --latency MS --jitter MS --loss PCT   simulated network conditions\n"
         "  --server HOST:PORT --token T [--track-file F]   direct connect, no lobby\n"
         "  --exit-after-race    quit after the first race\n"
         "  --log-file F --log-level error|warn|info|debug|trace --profile-file F\n";
}

std::wstring appDataDir() {
  const wchar_t *base = _wgetenv(L"APPDATA");
  std::error_code ec;
  std::filesystem::path path =
      base && *base ? std::filesystem::path(base) : std::filesystem::current_path(ec);
  path /= L"CarGameNative";
  std::filesystem::create_directories(path, ec);
  return path.wstring();
}

// ---------------------------------------------------------------------------------------------
// ApiWorker

ApiWorker::ApiWorker(std::string baseUrl) : baseUrl_(std::move(baseUrl)) {
  thread_ = std::thread([this] { run(); });
}

ApiWorker::~ApiWorker() { stop(); }

void ApiWorker::post(Job job) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_) return;
    jobs_.push_back(std::move(job));
  }
  cv_.notify_one();
}

void ApiWorker::drain() {
  std::vector<Completion> done;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    done.swap(done_);
  }
  for (auto &completion : done)
    if (completion) completion();
}

bool ApiWorker::idle() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return jobs_.empty() && !running_;
}

void ApiWorker::stop(Job finalJob) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopping_) {
      jobs_.clear();
      if (finalJob) jobs_.push_back(std::move(finalJob));
      stopping_ = true;
    }
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void ApiWorker::run() {
  LobbyApi api(baseUrl_);
  for (;;) {
    Job job;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [&] { return stopping_ || !jobs_.empty(); });
      if (jobs_.empty()) return;
      job = std::move(jobs_.front());
      jobs_.pop_front();
      running_ = true;
    }
    Completion completion;
    try {
      completion = job(api);
    } catch (const std::exception &e) {
      CG_ERROR("api job failed: %s", e.what());
    }
    std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
    if (completion && !stopping_) done_.push_back(std::move(completion));
  }
}

// ---------------------------------------------------------------------------------------------
// App: lifecycle

App::App(Config config) : config_(std::move(config)) {}

App::~App() { shutdown(); }

bool App::init(HWND hwnd) {
  hwnd_ = hwnd;
  if (!renderer_.init(hwnd)) return false;
  autopilot_ = config_.ai;
  createLaps_ = config_.laps;
  createBots_ = config_.bots;
  colorIndex_ = colorIndexOf(config_.color);
  lastFrame_ = nowMillis();

  if (!config_.server.empty()) {
    directMode_ = true;
    Address server;
    if (!parseHostPort(config_.server, kDefaultPort, server)) {
      screen_ = Screen::Message;
      message_ = L"Cannot resolve " + widen(config_.server);
      return true;
    }
    startRace(server, config_.token, "direct");
    return true;
  }
  api_ = std::make_unique<ApiWorker>(config_.api);
  startProfile();
  return true;
}

void App::shutdown() {
  if (race_) {
    if (race_->started && race_->net &&
        (race_->net->state() == NetClient::State::Connected ||
         race_->net->state() == NetClient::State::Connecting))
      race_->net->disconnect();
    race_.reset();
  }
  if (api_) {
    ApiWorker::Job leave;
    if (inLobby_) {
      std::string id = lobby_.id, pid = profile_.id;
      leave = [id, pid](LobbyApi &api) -> ApiWorker::Completion {
        api.leaveLobby(id, pid);
        CG_INFO("left lobby %s", id.c_str());
        return nullptr;
      };
      inLobby_ = false;
    }
    api_->stop(leave);
    api_.reset();
  }
  renderer_.shutdown();
}

void App::onResize(UINT width, UINT height) { renderer_.resize(width, height); }

void App::frame() {
  double now = nowMillis();
  double dt = now - lastFrame_;
  lastFrame_ = now;
  if (dt > 0) fps_ = fps_ * 0.95 + (1000.0 / dt) * 0.05;

  bool focused = GetForegroundWindow() == hwnd_;
  input_.poll(focused);
  for (int vk : input_.takePadKeys()) onKey(vk);
  if (api_) api_->drain();
  if (race_) updateRace(now);

  if (api_ && !profile_.id.empty()) {
    if ((screen_ == Screen::Browser || screen_ == Screen::Create) && !lobbiesPending_ &&
        now >= nextLobbyPoll_)
      pollLobbies();
    if (inLobby_ && (screen_ == Screen::Room || screen_ == Screen::Results) && !roomPending_ &&
        now >= nextRoomPoll_)
      pollRoom();
  }
  if (screen_ == Screen::Startup && retryAt_ > 0 && now >= retryAt_) {
    retryAt_ = 0;
    startProfile();
  }

  if (renderer_.deviceLost()) {
    CG_WARN("graphics device lost; recreating");
    renderer_.shutdown();
    if (!renderer_.init(hwnd_)) {
      quit_ = true;
      return;
    }
    if (race_) {
      race_->mesh = Mesh{};
      race_->meshTrack.reset();
    }
  }
  if (minimized_) {
    sleepMillis(5);
    return;
  }
  render(now);
}

// ---------------------------------------------------------------------------------------------
// Profile

void App::startProfile() {
  if (profilePath_.empty()) {
    if (!config_.profileFile.empty()) profilePath_ = widen(config_.profileFile);
    else if (!config_.nickname.empty())
      profilePath_ = appDataDir() + L"\\profile-" + widen(config_.nickname) + L".json";
    else profilePath_ = appDataDir() + L"\\profile.json";
  }
  Profile stored;
  {
    std::ifstream in{std::filesystem::path(profilePath_)};
    if (in) {
      std::stringstream ss;
      ss << in.rdbuf();
      Json json = Json::parse(ss.str());
      stored.id = json["id"].string();
      stored.nickname = json["nickname"].string();
      stored.color = json["color"].string();
    }
  }
  std::string nick = config_.nickname.empty() ? stored.nickname : config_.nickname;
  std::string color = !config_.color.empty() ? config_.color
                      : stored.color.empty() ? std::string(kColors[0].name)
                                             : stored.color;
  colorIndex_ = colorIndexOf(color);
  if (nick.empty()) {
    screen_ = Screen::Profile;
    nicknameInput_.clear();
    return;
  }
  screen_ = Screen::Startup;
  message_ = L"Signing in as " + widen(nick) + L"...";
  messageDetail_ = widen(config_.api);
  std::string storedId = stored.nickname == nick ? stored.id : std::string();
  api_->post([this, storedId, nick, color](LobbyApi &api) -> ApiWorker::Completion {
    Profile p;
    bool ok = false;
    if (!storedId.empty() && api.getProfile(storedId, p)) {
      ok = true;
      if (p.color != color) {
        p.color = color;
        if (!api.updateProfile(p)) CG_WARN("profile update failed: %s", api.lastError().c_str());
      }
    } else {
      if (!storedId.empty()) CG_INFO("stored profile not found; creating a new one");
      ok = api.createProfile(nick, color, p);
    }
    std::string error = ok ? std::string() : api.lastError();
    return [this, ok, p, error]() {
      if (ok) {
        profile_ = p;
        if (profile_.color.empty()) profile_.color = kColors[colorIndex_].name;
        saveProfile();
        CG_INFO("signed in as %s (%s)", profile_.nickname.c_str(), profile_.id.c_str());
        enterBrowser();
      } else {
        CG_WARN("profile request failed: %s", error.c_str());
        message_ = L"Cannot reach the game server";
        messageDetail_ = widen(config_.api + " - " + error) + L"\nRetrying...";
        retryAt_ = nowMillis() + 3000;
      }
    };
  });
}

void App::submitProfile() {
  if (profileBusy_) return;
  if (!validNickname(nicknameInput_)) {
    profileError_ = L"Nickname must be 2-16 characters: letters, digits, _ or -";
    return;
  }
  profileError_.clear();
  profileBusy_ = true;
  std::string nick = narrow(nicknameInput_);
  std::string color = kColors[colorIndex_].name;
  Profile current = profile_;
  api_->post([this, nick, color, current](LobbyApi &api) -> ApiWorker::Completion {
    Profile p = current;
    bool ok;
    if (!p.id.empty()) {
      p.nickname = nick;
      p.color = color;
      ok = api.updateProfile(p);
    } else {
      ok = api.createProfile(nick, color, p);
    }
    std::string error = ok ? std::string() : api.lastError();
    return [this, ok, p, error]() {
      profileBusy_ = false;
      if (!ok) {
        profileError_ = widen(error.empty() ? "request failed" : error);
        return;
      }
      profile_ = p;
      saveProfile();
      CG_INFO("profile saved: %s (%s)", profile_.nickname.c_str(), profile_.id.c_str());
      enterBrowser();
    };
  });
}

void App::saveProfile() {
  Json json = Json::object();
  json.set("id", profile_.id);
  json.set("nickname", profile_.nickname);
  json.set("color", profile_.color);
  std::ofstream out{std::filesystem::path(profilePath_), std::ios::trunc};
  if (out) out << json.dump() << "\n";
  else CG_WARN("cannot write %s", narrow(profilePath_).c_str());
}

// ---------------------------------------------------------------------------------------------
// Lobby flow

void App::enterBrowser() {
  screen_ = Screen::Browser;
  nextLobbyPoll_ = 0;
  if (tracks_.empty()) requestTracks();
}

void App::requestTracks() {
  if (tracksPending_ || !api_) return;
  tracksPending_ = true;
  api_->post([this](LobbyApi &api) -> ApiWorker::Completion {
    std::vector<TrackInfo> list;
    bool ok = api.listTracks(list);
    std::string error = ok ? std::string() : api.lastError();
    return [this, ok, list, error]() {
      tracksPending_ = false;
      if (!ok) {
        showError("Cannot list tracks: " + error);
        return;
      }
      tracks_ = list;
      int index = trackIndex("bristol-short-oval");
      createTrack_ = std::max(0, index);
    };
  });
}

void App::prefetchTrack(const std::string &trackId) {
  if (trackId.empty() || trackCache_.count(trackId) || trackPending_[trackId] || !api_) return;
  trackPending_[trackId] = true;
  api_->post([this, trackId](LobbyApi &api) -> ApiWorker::Completion {
    auto track = api.getTrack(trackId);
    std::string error = track ? std::string() : api.lastError();
    return [this, trackId, track, error]() {
      trackPending_[trackId] = false;
      if (track) {
        trackCache_[trackId] = track;
        CG_INFO("track %s cached (%s)", trackId.c_str(), track->name.c_str());
      } else {
        CG_WARN("cannot fetch track %s: %s", trackId.c_str(), error.c_str());
      }
    };
  });
}

void App::pollLobbies() {
  lobbiesPending_ = true;
  api_->post([this](LobbyApi &api) -> ApiWorker::Completion {
    std::vector<Lobby> list;
    bool ok = api.listLobbies(list);
    std::string error = ok ? std::string() : api.lastError();
    return [this, ok, list, error]() {
      lobbiesPending_ = false;
      nextLobbyPoll_ = nowMillis() + 2000;
      if (!ok) {
        showError("Cannot list lobbies: " + error);
        return;
      }
      lobbies_ = list;
      browserSel_ = std::clamp(browserSel_, 0, std::max(0, static_cast<int>(lobbies_.size()) - 1));
      runAutoActions();
    };
  });
}

void App::runAutoActions() {
  if (screen_ != Screen::Browser || autoJoinDone_ || actionPending_) return;
  if (!config_.createTrack.empty()) {
    autoJoinDone_ = true;
    actionPending_ = true;
    std::string pid = profile_.id, track = config_.createTrack;
    int laps = config_.laps, bots = config_.bots;
    CG_INFO("auto: creating lobby on %s (%d laps, %d bots)", track.c_str(), laps, bots);
    api_->post([this, pid, track, laps, bots](LobbyApi &api) -> ApiWorker::Completion {
      Lobby lobby;
      bool ok = api.createLobby(pid, track, laps, bots, lobby);
      std::string error = ok ? std::string() : api.lastError();
      return [this, ok, lobby, error]() {
        actionPending_ = false;
        if (ok) enterRoom(lobby);
        else showError("Cannot create lobby: " + error);
      };
    });
    return;
  }
  if (config_.joinAny) {
    for (const Lobby &l : lobbies_) {
      if (l.status != "waiting") continue;
      autoJoinDone_ = true;
      CG_INFO("auto: joining lobby %s (%s)", l.id.c_str(), l.name.c_str());
      browserSel_ = static_cast<int>(&l - lobbies_.data());
      keyBrowser(VK_RETURN);
      return;
    }
  }
}

void App::enterRoom(const Lobby &lobby) {
  lobby_ = lobby;
  inLobby_ = true;
  lobbyGeneration_++;
  screen_ = Screen::Room;
  roomRow_ = 0;
  nextRoomPoll_ = 0;
  roomFailures_ = 0;
  readyPending_ = startPending_ = false;
  CG_INFO("entered lobby %s (%s) on %s", lobby.id.c_str(), lobby.name.c_str(),
          lobby.trackName.c_str());
  prefetchTrack(lobby.trackId);
  if (tracks_.empty()) requestTracks();
  handleRoomUpdate(lobby);
}

void App::leaveRoom() {
  if (inLobby_ && api_) {
    std::string id = lobby_.id, pid = profile_.id;
    api_->post([id, pid](LobbyApi &api) -> ApiWorker::Completion {
      if (!api.leaveLobby(id, pid)) CG_WARN("leave lobby failed: %s", api.lastError().c_str());
      return nullptr;
    });
    CG_INFO("leaving lobby %s", id.c_str());
  }
  inLobby_ = false;
  lobbyGeneration_++;
  lobby_ = Lobby{};
  enterBrowser();
}

void App::pollRoom() {
  roomPending_ = true;
  int generation = lobbyGeneration_;
  std::string id = lobby_.id, pid = profile_.id;
  api_->post([this, generation, id, pid](LobbyApi &api) -> ApiWorker::Completion {
    Lobby lobby;
    bool ok = api.getLobby(id, pid, lobby);
    std::string error = ok ? std::string() : api.lastError();
    return [this, generation, ok, lobby, error]() {
      roomPending_ = false;
      nextRoomPoll_ = nowMillis() + 500;
      if (generation != lobbyGeneration_ || !inLobby_) return;
      if (ok) {
        roomFailures_ = 0;
        handleRoomUpdate(lobby);
        return;
      }
      roomFailures_++;
      CG_WARN("lobby poll failed (%d): %s", roomFailures_, error.c_str());
      if (lower(error).find("not found") != std::string::npos) {
        inLobby_ = false;
        lobbyGeneration_++;
        showToast(L"The lobby no longer exists");
        if (screen_ == Screen::Room) enterBrowser();
      } else if (roomFailures_ == 4) {
        showError("Lobby server not responding: " + error);
      }
    };
  });
}

void App::handleRoomUpdate(const Lobby &lobby) {
  if (lobby.message != lobby_.message && !lobby.message.empty())
    CG_INFO("lobby message: %s", lobby.message.c_str());
  lobby_ = lobby;
  prefetchTrack(lobby.trackId);
  if (screen_ != Screen::Room) return;
  if (!me()) {
    CG_WARN("no longer a member of lobby %s", lobby.id.c_str());
    inLobby_ = false;
    lobbyGeneration_++;
    showToast(L"You are no longer in the lobby");
    enterBrowser();
    return;
  }
  if (lobby.hasConnection && lobby.connection.matchId != consumedMatchId_ && !connectPending_) {
    connectPending_ = true;
    consumedMatchId_ = lobby.connection.matchId;
    LobbyConnection c = lobby.connection;
    CG_INFO("match %s available at %s:%d", c.matchId.c_str(), c.host.c_str(), c.port);
    api_->post([this, c](LobbyApi &api) -> ApiWorker::Completion {
      std::string host = c.host.empty() ? api.serverHost() : c.host;
      Address address;
      bool ok = resolveAddress(host, static_cast<uint16_t>(c.port), address);
      return [this, c, host, ok, address]() {
        connectPending_ = false;
        if (!ok) {
          showError("Cannot resolve game server " + host);
          return;
        }
        if (screen_ != Screen::Room || !inLobby_) return;
        startRace(address, c.token, c.matchId);
      };
    });
    return;
  }
  if (lobby.status != "waiting") return;
  const LobbyPlayer *self = me();
  if (config_.autoReady && !self->ready && !readyPending_) {
    readyPending_ = true;
    std::string id = lobby.id, pid = profile_.id;
    CG_INFO("auto: ready");
    api_->post([this, id, pid](LobbyApi &api) -> ApiWorker::Completion {
      bool ok = api.setReady(id, pid, true);
      std::string error = ok ? std::string() : api.lastError();
      return [this, ok, error]() {
        readyPending_ = false;
        nextRoomPoll_ = 0;
        if (!ok) showError("Ready failed: " + error);
      };
    });
  }
  if (config_.startWhen > 0 && isHost() && !startPending_ &&
      static_cast<int>(lobby.players.size()) >= config_.startWhen) {
    bool allReady = std::all_of(lobby.players.begin(), lobby.players.end(),
                                [](const LobbyPlayer &p) { return p.ready; });
    if (allReady) {
      CG_INFO("auto: starting with %zu players", lobby.players.size());
      keyRoom('S');
    }
  }
}

void App::sendSettings(const std::string &trackId, int laps, int bots) {
  lobby_.trackId = trackId;
  int index = trackIndex(trackId);
  if (index >= 0) lobby_.trackName = tracks_[index].name;
  lobby_.lapCount = laps;
  lobby_.botCount = bots;
  prefetchTrack(trackId);
  std::string id = lobby_.id, pid = profile_.id;
  api_->post([this, id, pid, trackId, laps, bots](LobbyApi &api) -> ApiWorker::Completion {
    bool ok = api.updateSettings(id, pid, trackId, laps, bots);
    std::string error = ok ? std::string() : api.lastError();
    return [this, ok, error]() {
      nextRoomPoll_ = 0;
      if (!ok) showError("Cannot change settings: " + error);
    };
  });
}

const LobbyPlayer *App::me() const {
  for (const LobbyPlayer &p : lobby_.players)
    if (p.profileId == profile_.id) return &p;
  return nullptr;
}

int App::trackIndex(const std::string &id) const {
  for (size_t i = 0; i < tracks_.size(); ++i)
    if (tracks_[i].id == id) return static_cast<int>(i);
  return -1;
}

void App::showError(const std::string &text) {
  CG_WARN("%s", text.c_str());
  showToast(widen(text), 5);
}

void App::showToast(const std::wstring &text, double seconds) {
  toast_ = text;
  toastUntil_ = nowMillis() + seconds * 1000;
}

// ---------------------------------------------------------------------------------------------
// Race

std::shared_ptr<const Track> App::resolveTrack(const std::string &trackId) {
  if (directMode_ && !config_.trackFile.empty()) {
    auto track = std::make_shared<Track>();
    std::string error;
    if (loadTrackFile(config_.trackFile, *track, &error)) return track;
    CG_ERROR("cannot load %s: %s", config_.trackFile.c_str(), error.c_str());
    return nullptr;
  }
  auto it = trackCache_.find(trackId);
  if (it != trackCache_.end()) return it->second;
  // Normally prefetched while in the lobby; fall back to a one-off blocking fetch.
  CG_WARN("track %s was not prefetched; fetching now", trackId.c_str());
  LobbyApi api(config_.api);
  auto track = api.getTrack(trackId);
  if (track) trackCache_[trackId] = track;
  else CG_ERROR("cannot fetch track %s: %s", trackId.c_str(), api.lastError().c_str());
  return track;
}

void App::startRace(const Address &server, const std::string &token, const std::string &matchId) {
  race_ = std::make_unique<RaceState>();
  NetClient::Options options;
  options.server = server;
  options.token = token;
  options.conditions = config_.conditions;
  options.seed = static_cast<uint32_t>(GetTickCount64() & 0x7fffffff) | 1u;
  race_->net = std::make_unique<NetClient>(
      options, [this](const std::string &trackId) { return resolveTrack(trackId); });
  race_->matchId = matchId;
  race_->driverNeedsReset = true;
  race_->lastFrameMs = nowMillis();
  race_->started = race_->net->start();
  if (!race_->started) {
    race_->failedAt = nowMillis();
    race_->failMessage = widen(race_->net->statusMessage());
  }
  screen_ = Screen::Race;
  CG_INFO("race: connecting to %s (match %s) latency=%dms jitter=%dms loss=%.1f%% autopilot=%s",
          server.toString().c_str(), matchId.c_str(), config_.conditions.latencyMs,
          config_.conditions.jitterMs, config_.conditions.lossPercent, autopilot_ ? "on" : "off");
}

void App::endRace(bool backToRoom) {
  if (race_ && race_->started && race_->net &&
      (race_->net->state() == NetClient::State::Connected ||
       race_->net->state() == NetClient::State::Connecting))
    race_->net->disconnect();
  race_.reset();
  if (backToRoom && inLobby_) {
    screen_ = Screen::Room;
    nextRoomPoll_ = 0;
    readyPending_ = startPending_ = false;
  } else if (directMode_) {
    quit_ = true;
  } else {
    enterBrowser();
  }
}

void App::setAutopilot(bool on) {
  autopilot_ = on;
  if (race_) race_->driverNeedsReset = true;
  CG_INFO("autopilot %s", on ? "on" : "off");
  showToast(on ? L"AI autopilot ON" : L"AI autopilot OFF", 2);
}

void App::applyConditions(const NetConditions &c) {
  config_.conditions = c;
  if (race_ && race_->started) race_->net->setConditions(c);
  CG_INFO("net conditions: latency=%dms jitter=%dms loss=%.1f%%", c.latencyMs, c.jitterMs,
          c.lossPercent);
  showToast(wfmt(L"Simulated network: latency %d ms, jitter %d ms, loss %.0f%%", c.latencyMs,
                 c.jitterMs, c.lossPercent),
            3);
}

InputCmd App::sampleInput(int32_t tick, const World &world, int slot) {
  bool focused = GetForegroundWindow() == hwnd_;
  InputCmd human = input_.sample(focused);
  RaceState &r = *race_;
  if (autopilot_ && r.driver) {
    if (tick < r.net->raceStartTick()) return {};
    if (r.driverNeedsReset) {
      r.driver->reset(world, slot, tick);
      r.driverNeedsReset = false;
    }
    InputCmd cmd = r.driver->update(world, slot, tick);
    r.aiSteer = cmd.steering();
    if (human.has(kInputRespawn)) cmd.buttons |= kInputRespawn;
    return cmd;
  }
  return human;
}

void App::ensureTrackMesh() {
  RaceState &r = *race_;
  auto track = r.net->track();
  if (!track || r.meshTrack == track) return;
  double start = nowMillis();
  r.meshData = buildTrackMesh(*track);
  if (!renderer_.createMesh(r.meshData.vertices, r.mesh)) CG_ERROR("cannot create track mesh");
  r.meshData.vertices.clear();
  r.meshData.vertices.shrink_to_fit();
  r.meshTrack = track;
  CG_INFO("track mesh built in %.1f ms", nowMillis() - start);
  if (r.camera == Vec2{}) r.camera = {track->width / 2, track->height / 2};
}

void App::updateRace(double now) {
  RaceState &r = *race_;
  NetClient &net = *r.net;
  if (r.started &&
      (net.state() == NetClient::State::Connecting || net.state() == NetClient::State::Connected))
    net.update([this](int32_t tick, const World &world, int slot) {
      return sampleInput(tick, world, slot);
    });
  ensureTrackMesh();

  if (net.track() && !r.line && !r.lineFuture.valid()) {
    auto track = net.track();
    r.lineFuture = std::async(std::launch::async, [track] { return buildRacingLine(*track); });
  }
  if (r.lineFuture.valid() &&
      r.lineFuture.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
    r.line = r.lineFuture.get();
    if (r.line) {
      r.driver = std::make_unique<BotDriver>(r.line, BotSkill::Medium,
                                             static_cast<uint32_t>(net.slot() + 1) * 2654435761u);
      CG_INFO("racing line ready; autopilot available");
    } else {
      CG_WARN("no racing line for this track; autopilot unavailable");
    }
  }

  const World *world = net.world();
  int slot = net.slot();
  if (world && slot >= 0 && slot < world->slots()) {
    if (r.lapStartTick == INT32_MAX && net.raceStartTick() != INT32_MAX)
      r.lapStartTick = net.raceStartTick();
    const CarState &car = world->cars[slot];
    if (car.lap > r.lastLap) {
      r.lastLap = car.lap;
      r.lapStartTick = net.predictedTick();
      CG_INFO("lap %d reached (tick %d)", car.lap + 1, net.predictedTick());
    }
    const auto &meta = net.meta();
    if (static_cast<size_t>(slot) < meta.size() && meta[slot].finished && !r.finishedLogged) {
      r.finishedLogged = true;
      CG_INFO("finished the race: position %d, time %.3fs, best lap %.3fs", meta[slot].rank,
              meta[slot].finishMs / 1000.0, meta[slot].bestLapMs / 1000.0);
    }
  }

  if (r.started && now - r.lastStatsLogMs >= 5000 && net.state() == NetClient::State::Connected) {
    r.lastStatsLogMs = now;
    auto s = net.stats();
    CG_INFO("net phase=%s tick=%d srv=%d rtt=%.0fms jit=%.1fms lead=%d/%.1f scale=%.3f "
            "resim=%d corr=%.2f/%.2fpx mis=%llu gaps=%llu in=%.0fB/s out=%.0fB/s fps=%.0f",
            phaseName(net.phase()), s.predictedTick, s.serverTick, s.rttMs, s.jitterMs,
            s.serverLead, s.targetLead, s.timeScale, s.lastResimTicks, s.lastCorrectionPx,
            s.maxCorrectionPx, static_cast<unsigned long long>(s.mispredictions),
            static_cast<unsigned long long>(s.snapshotGaps), s.bytesInPerSec, s.bytesOutPerSec,
            fps_);
  }

  if (net.state() == NetClient::State::Ended && r.endedAt == 0) {
    r.endedAt = now;
    racesCompleted_++;
    CG_INFO("race ended: %s", net.statusMessage().c_str());
    for (const ResultEntry &e : net.results()) {
      std::string name =
          static_cast<size_t>(e.slot) < net.meta().size() ? net.meta()[e.slot].info.nickname : "?";
      CG_INFO("result P%d %s %s total=%.3fs best=%.3fs", e.position, name.c_str(),
              e.finished ? "finished" : "DNF", e.totalMs / 1000.0, e.bestLapMs / 1000.0);
    }
    screen_ = Screen::Results;
    nextRoomPoll_ = 0;
  }
  if (net.state() == NetClient::State::Failed && r.failedAt == 0) {
    r.failedAt = now;
    r.failMessage = net.lostConnection() ? std::wstring(L"Connection to game server lost")
                                         : widen(net.statusMessage());
    CG_WARN("race failed: %s (lost=%d)", net.statusMessage().c_str(), net.lostConnection());
  }
  if (r.failedAt > 0 && now - r.failedAt > 2500) {
    if (config_.exitAfterRace || directMode_) {
      if (config_.exitAfterRace) quit_ = true;
    } else {
      roomBanner_ = r.failMessage;
      roomBannerUntil_ = now + 15000;
      endRace(true);
      return;
    }
  }
  if (screen_ == Screen::Results && now - r.endedAt > 8000) {
    if (config_.exitAfterRace) quit_ = true;
    else if (!directMode_) endRace(true);
  }
}

// ---------------------------------------------------------------------------------------------
// Input

void App::onChar(wchar_t ch) {
  if (screen_ != Screen::Profile || profileBusy_) return;
  if (ch == L'\b') {
    if (!nicknameInput_.empty()) nicknameInput_.pop_back();
    return;
  }
  bool ok = (ch >= L'a' && ch <= L'z') || (ch >= L'A' && ch <= L'Z') ||
            (ch >= L'0' && ch <= L'9') || ch == L'_' || ch == L'-';
  if (ok && nicknameInput_.size() < 16) nicknameInput_.push_back(ch);
}

void App::onKey(int vk) {
  switch (vk) {
  case VK_F3: showNet_ = !showNet_; return;
  case VK_F4:
    showGhosts_ = !showGhosts_;
    showToast(showGhosts_ ? L"Ghosts ON (raw predicted state)" : L"Ghosts OFF", 2);
    return;
  case VK_F5:
  case VK_F6: {
    NetConditions c = config_.conditions;
    c.latencyMs = std::clamp(c.latencyMs + (vk == VK_F5 ? -25 : 25), 0, 1000);
    applyConditions(c);
    return;
  }
  case VK_F7: {
    NetConditions c = config_.conditions;
    c.jitterMs = c.jitterMs < 10 ? 10 : c.jitterMs < 30 ? 30 : 0;
    applyConditions(c);
    return;
  }
  case VK_F8: {
    NetConditions c = config_.conditions;
    c.lossPercent = c.lossPercent < 2 ? 2 : c.lossPercent < 5 ? 5 : c.lossPercent < 10 ? 10 : 0;
    applyConditions(c);
    return;
  }
  case VK_F9: setAutopilot(!autopilot_); return;
  default: break;
  }
  switch (screen_) {
  case Screen::Startup:
  case Screen::Message:
    if (vk == VK_ESCAPE) quit_ = true;
    else if (vk == VK_RETURN && screen_ == Screen::Startup && retryAt_ > 0) retryAt_ = 1;
    break;
  case Screen::Profile: keyProfile(vk); break;
  case Screen::Browser: keyBrowser(vk); break;
  case Screen::Create: keyCreate(vk); break;
  case Screen::Room: keyRoom(vk); break;
  case Screen::Race: keyRace(vk); break;
  case Screen::Results:
    if (vk == VK_RETURN || vk == VK_ESCAPE || vk == VK_SPACE) {
      if (config_.exitAfterRace) quit_ = true;
      else endRace(true);
    }
    break;
  }
}

void App::keyProfile(int vk) {
  if (vk == VK_LEFT) colorIndex_ = (colorIndex_ + kColorCount - 1) % kColorCount;
  else if (vk == VK_RIGHT) colorIndex_ = (colorIndex_ + 1) % kColorCount;
  else if (vk == VK_RETURN) submitProfile();
  else if (vk == VK_ESCAPE) {
    if (!profile_.id.empty()) enterBrowser();
    else quit_ = true;
  }
}

void App::keyBrowser(int vk) {
  int count = static_cast<int>(lobbies_.size());
  if (vk == VK_UP && count) browserSel_ = (browserSel_ + count - 1) % count;
  else if (vk == VK_DOWN && count) browserSel_ = (browserSel_ + 1) % count;
  else if (vk == 'R') nextLobbyPoll_ = 0;
  else if (vk == 'N' || vk == 'C') {
    screen_ = Screen::Create;
    createRow_ = 0;
    if (tracks_.empty()) requestTracks();
  } else if (vk == 'P') {
    screen_ = Screen::Profile;
    nicknameInput_ = widen(profile_.nickname);
    colorIndex_ = colorIndexOf(profile_.color);
    profileError_.clear();
  } else if (vk == VK_ESCAPE) {
    quit_ = true;
  } else if (vk == VK_RETURN && browserSel_ < count && !actionPending_) {
    actionPending_ = true;
    std::string id = lobbies_[browserSel_].id, pid = profile_.id;
    api_->post([this, id, pid](LobbyApi &api) -> ApiWorker::Completion {
      Lobby lobby;
      bool ok = api.joinLobby(id, pid, lobby);
      std::string error = ok ? std::string() : api.lastError();
      return [this, ok, lobby, error]() {
        actionPending_ = false;
        if (ok) enterRoom(lobby);
        else {
          autoJoinDone_ = false;
          showError("Cannot join lobby: " + error);
        }
      };
    });
  }
}

void App::keyCreate(int vk) {
  int trackCount = static_cast<int>(tracks_.size());
  if (vk == VK_ESCAPE) screen_ = Screen::Browser;
  else if (vk == VK_UP) createRow_ = (createRow_ + 3) % 4;
  else if (vk == VK_DOWN) createRow_ = (createRow_ + 1) % 4;
  else if (vk == VK_LEFT || vk == VK_RIGHT) {
    int d = vk == VK_LEFT ? -1 : 1;
    if (createRow_ == 0 && trackCount) createTrack_ = (createTrack_ + d + trackCount) % trackCount;
    else if (createRow_ == 1) createLaps_ = std::clamp(createLaps_ + d, 1, 20);
    else if (createRow_ == 2) createBots_ = std::clamp(createBots_ + d, 0, 7);
  } else if (vk == VK_RETURN && trackCount && !actionPending_) {
    actionPending_ = true;
    std::string pid = profile_.id, track = tracks_[createTrack_].id;
    int laps = createLaps_, bots = createBots_;
    api_->post([this, pid, track, laps, bots](LobbyApi &api) -> ApiWorker::Completion {
      Lobby lobby;
      bool ok = api.createLobby(pid, track, laps, bots, lobby);
      std::string error = ok ? std::string() : api.lastError();
      return [this, ok, lobby, error]() {
        actionPending_ = false;
        if (ok) enterRoom(lobby);
        else showError("Cannot create lobby: " + error);
      };
    });
  }
}

void App::keyRoom(int vk) {
  const LobbyPlayer *self = me();
  if (vk == VK_ESCAPE) {
    leaveRoom();
  } else if ((vk == VK_RETURN || vk == VK_SPACE) && self && !readyPending_ &&
             lobby_.status == "waiting") {
    readyPending_ = true;
    bool ready = !self->ready;
    std::string id = lobby_.id, pid = profile_.id;
    api_->post([this, id, pid, ready](LobbyApi &api) -> ApiWorker::Completion {
      bool ok = api.setReady(id, pid, ready);
      std::string error = ok ? std::string() : api.lastError();
      return [this, ok, error]() {
        readyPending_ = false;
        nextRoomPoll_ = 0;
        if (!ok) showError("Ready failed: " + error);
      };
    });
  } else if (vk == 'S' && isHost() && !startPending_ && lobby_.status == "waiting") {
    startPending_ = true;
    std::string id = lobby_.id, pid = profile_.id;
    api_->post([this, id, pid](LobbyApi &api) -> ApiWorker::Completion {
      bool ok = api.startLobby(id, pid);
      std::string error = ok ? std::string() : api.lastError();
      return [this, ok, error]() {
        nextRoomPoll_ = 0;
        if (!ok) {
          showError("Cannot start: " + error);
          // Retry automatic starts only after a pause.
          startPending_ = false;
          nextRoomPoll_ = nowMillis() + 2000;
        }
      };
    });
  } else if (isHost() && lobby_.status == "waiting") {
    if (vk == VK_UP) roomRow_ = (roomRow_ + 2) % 3;
    else if (vk == VK_DOWN) roomRow_ = (roomRow_ + 1) % 3;
    else if (vk == VK_LEFT || vk == VK_RIGHT) {
      int d = vk == VK_LEFT ? -1 : 1;
      std::string trackId = lobby_.trackId;
      int laps = lobby_.lapCount, bots = lobby_.botCount;
      int count = static_cast<int>(tracks_.size());
      if (roomRow_ == 0 && count) {
        int index = std::max(0, trackIndex(trackId));
        trackId = tracks_[(index + d + count) % count].id;
      } else if (roomRow_ == 1) laps = std::clamp(laps + d, 1, 20);
      else if (roomRow_ == 2) bots = std::clamp(bots + d, 0, 7);
      sendSettings(trackId, laps, bots);
    }
  }
}

void App::keyRace(int vk) {
  if (vk != VK_ESCAPE || !race_) return;
  double now = nowMillis();
  if (race_->failedAt > 0 || now - race_->escAt < 2500) {
    CG_INFO("leaving the race");
    if (!race_->matchId.empty()) consumedMatchId_ = race_->matchId;
    endRace(true);
  } else {
    race_->escAt = now;
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering

Vec2 App::worldToUi(const Vec2 &p) const {
  double sx = (p.x - viewCenter_.x) * viewPpu_ + renderer_.width() / 2.0;
  double sy = (p.y - viewCenter_.y) * viewPpu_ + renderer_.height() / 2.0;
  return {sx / renderer_.uiScale(), sy / renderer_.uiScale()};
}

void App::render(double now) {
  bool inRace = race_ && (screen_ == Screen::Race || screen_ == Screen::Results);
  if (inRace) {
    drawWorld(now);
    drawRaceHud(now);
  } else {
    renderer_.beginFrame(hexColor(0x101a24));
    renderer_.beginOverlay();
    renderer_.setUiTransform();
    drawMenuBackground();
    switch (screen_) {
    case Screen::Profile: drawProfile(); break;
    case Screen::Browser: drawBrowser(); break;
    case Screen::Create: drawCreate(); break;
    case Screen::Room: drawRoom(now); break;
    default: drawMessage(); break;
    }
  }
  renderer_.setUiTransform();
  if (showNet_) drawNetOverlay();
  drawToast(now);
  renderer_.endFrame();
}

void App::drawWorld(double now) {
  RaceState &r = *race_;
  NetClient &net = *r.net;
  auto track = r.meshTrack;
  double dt = std::clamp((now - r.lastFrameMs) / 1000.0, 0.0, 0.1);
  r.lastFrameMs = now;

  int focus = net.slot();
  const World *world = net.world();
  NetClient::RenderCar focusCar;
  if (world && focus >= 0 && focus < world->slots()) focusCar = net.renderCar(focus);
  if (focusCar.active) {
    double speed = length(focusCar.vel);
    double t = std::clamp((speed - 3) / 12, 0.0, 1.0);
    double target = 1 - t * t * (3 - 2 * t) * 0.45;
    double rate = target < r.zoom ? 6 : 2;
    r.zoom += (target - r.zoom) * (1 - std::exp(-rate * dt));
    r.camera = focusCar.pos;
  }
  double ppu = r.zoom * renderer_.height() / 800.0;
  viewCenter_ = r.camera;
  viewPpu_ = ppu;

  uint32_t background = track ? r.meshData.background : hexColor(0x1a1a2e);
  bool wrap = track && track->wrapAround && track->width > 0 && track->height > 0;
  renderer_.beginFrame(wrap ? background : mixColor(background, rgba(0, 0, 0), 0.5f));
  renderer_.setView(r.camera.x, r.camera.y, ppu);

  double halfW = renderer_.width() / 2.0 / ppu, halfH = renderer_.height() / 2.0 / ppu;
  double left = r.camera.x - halfW, right = r.camera.x + halfW;
  double top = r.camera.y - halfH, bottom = r.camera.y + halfH;
  std::vector<Vec2> offsets;
  if (wrap) {
    int kx0 = static_cast<int>(std::floor(left / track->width));
    int kx1 = static_cast<int>(std::floor(right / track->width));
    int ky0 = static_cast<int>(std::floor(top / track->height));
    int ky1 = static_cast<int>(std::floor(bottom / track->height));
    for (int ky = ky0; ky <= ky1 && offsets.size() < 64; ++ky)
      for (int kx = kx0; kx <= kx1 && offsets.size() < 64; ++kx)
        offsets.push_back({kx * track->width, ky * track->height});
  } else {
    offsets.push_back({0, 0});
  }
  if (r.mesh.buffer)
    for (const Vec2 &o : offsets) renderer_.drawMesh(r.mesh, 0, r.mesh.count, o.x, o.y);

  auto visible = [&](const Vec2 &p, double margin) {
    return p.x > left - margin && p.x < right + margin && p.y > top - margin &&
           p.y < bottom + margin;
  };

  // Cars: remote cars first, the local car on top.
  Vertices cars;
  struct Label {
    Vec2 pos;
    std::wstring text;
    uint32_t color;
  };
  std::vector<Label> labels;
  const auto &meta = net.meta();
  double localSteer = autopilot_ && r.driver ? r.aiSteer : input_.steerVisual();
  steerVisual_ += (localSteer - steerVisual_) * std::min(1.0, dt * 15);
  if (world) {
    std::vector<int> order;
    for (int i = 0; i < world->slots(); ++i)
      if (i != focus) order.push_back(i);
    if (focus >= 0 && focus < world->slots()) order.push_back(focus);
    for (int i : order) {
      NetClient::RenderCar rc = net.renderCar(i);
      if (!rc.active) continue;
      CarLook look;
      bool hasMeta = static_cast<size_t>(i) < meta.size();
      look.color = parseColor(hasMeta ? meta[i].info.color : std::string(), hexColor(0xDC2626));
      look.nitro = rc.nitroActive;
      look.steer = i == focus ? steerVisual_ : 0;
      look.alpha = hasMeta && !meta[i].connected ? 0.45f : 1.0f;
      for (const Vec2 &o : offsets) {
        Vec2 p = rc.pos + o;
        if (!visible(p, 80)) continue;
        if (showGhosts_) {
          const CarState &raw = world->cars[i];
          addCarGhost(cars, raw.pos + o, raw.angle, rgba(80, 255, 255, 200));
        }
        addCar(cars, p, rc.angle, look);
        if (hasMeta)
          labels.push_back({p, widen(meta[i].info.nickname),
                            i == focus ? kAccent : rgba(255, 255, 255, 230)});
      }
    }
  }
  renderer_.drawVertices(cars);

  renderer_.beginOverlay();
  if (track) {
    for (const TrackLabel &label : r.meshData.labels) {
      for (const Vec2 &o : offsets) {
        Vec2 p = label.position + o;
        if (!visible(p, 400 * label.scale)) continue;
        renderer_.setWorldTransform(p.x, p.y, label.rotation, label.scale);
        if (label.big)
          renderer_.text(label.text, -400, -25, 800, 50, Font::WorldLabel, rgba(237, 242, 239),
                         Align::Center, false, true);
        else
          renderer_.text(label.text, -300, 40, 600, 20, Font::WorldSmall, rgba(237, 242, 239),
                         Align::Center, false, true);
      }
    }
  }
  renderer_.setUiTransform();
  for (const Label &l : labels) {
    Vec2 ui = worldToUi(l.pos);
    float y = static_cast<float>(ui.y - 34 * viewPpu_ / renderer_.uiScale()) - 18;
    renderer_.text(l.text, static_cast<float>(ui.x) - 100, y, 200, 18, Font::Small, l.color,
                   Align::Center, true);
  }
}

void App::drawRaceHud(double now) {
  RaceState &r = *race_;
  NetClient &net = *r.net;
  float w = renderer_.uiWidth(), h = renderer_.uiHeight();
  const World *world = net.world();
  int slot = net.slot();
  bool haveCar = world && slot >= 0 && slot < world->slots();

  if (r.failedAt > 0) {
    renderer_.fillRect(0, 0, w, h, rgba(0, 0, 0, 120));
    renderer_.fillRect(w / 2 - 300, h / 2 - 70, 600, 140, kPanelSolid, 10);
    renderer_.text(r.failMessage, w / 2 - 290, h / 2 - 50, 580, 50, Font::Large, kBad,
                   Align::Center, true, true);
    std::wstring sub = directMode_ ? L"Press Esc to quit" : L"Returning to the lobby...";
    renderer_.text(sub, w / 2 - 290, h / 2 + 10, 580, 30, Font::Normal, kDim, Align::Center);
    return;
  }
  if (net.state() == NetClient::State::Connecting) {
    renderer_.fillRect(w / 2 - 260, h / 2 - 50, 520, 100, kPanelSolid, 10);
    renderer_.text(L"Connecting to game server...", w / 2 - 250, h / 2 - 40, 500, 40, Font::Medium,
                   kText, Align::Center, false, true);
    renderer_.text(widen(net.statusMessage()), w / 2 - 250, h / 2 + 5, 500, 30, Font::Small, kDim,
                   Align::Center, false, true);
    return;
  }

  int lapCount = std::max<int>(1, net.welcome().lapCount);
  int32_t tick = net.predictedTick();
  const auto &meta = net.meta();
  if (haveCar) {
    const CarState &car = world->cars[slot];
    int activeCars = 0;
    for (const CarState &c : world->cars) activeCars += c.active ? 1 : 0;
    int rank = static_cast<size_t>(slot) < meta.size() ? meta[slot].rank : 0;
    bool finished = static_cast<size_t>(slot) < meta.size() && meta[slot].finished;
    uint32_t bestLap = static_cast<size_t>(slot) < meta.size() ? meta[slot].bestLapMs : 0;
    uint32_t lastLap = static_cast<size_t>(slot) < meta.size() ? meta[slot].lastLapMs : 0;
    uint32_t current = 0;
    if (r.lapStartTick != INT32_MAX && tick > r.lapStartTick && !finished)
      current = static_cast<uint32_t>((tick - r.lapStartTick) * 1000.0 / physics::kTickRate);

    renderer_.fillRect(14, 14, 250, 150, kPanel, 8);
    renderer_.text(L"LAP", 28, 22, 80, 20, Font::Small, kDim);
    renderer_.text(wfmt(L"%d/%d", std::min(car.lap + 1, lapCount), lapCount), 28, 38, 110, 40,
                   Font::Large, kText);
    renderer_.text(L"POS", 150, 22, 80, 20, Font::Small, kDim);
    renderer_.text(rank > 0 ? wfmt(L"%d/%d", rank, activeCars) : wfmt(L"-/%d", activeCars), 150,
                   38, 110, 40, Font::Large, kText);
    renderer_.text(L"TIME", 28, 88, 60, 20, Font::Small, kDim);
    renderer_.text(finished ? fmtTime(meta[slot].finishMs) : fmtTimeOrDash(current), 100, 86, 150,
                   22, Font::Normal, finished ? kGood : kText);
    renderer_.text(L"BEST", 28, 110, 60, 20, Font::Small, kDim);
    renderer_.text(fmtTimeOrDash(bestLap), 100, 108, 150, 22, Font::Normal, kAccent);
    renderer_.text(L"LAST", 28, 132, 60, 20, Font::Small, kDim);
    renderer_.text(fmtTimeOrDash(lastLap), 100, 130, 150, 22, Font::Normal, kText);

    NetClient::RenderCar rc = net.renderCar(slot);
    double speed = length(rc.vel) * 10;
    renderer_.fillRect(w - 234, h - 104, 220, 90, kPanel, 8);
    renderer_.text(wfmt(L"%.0f", speed), w - 224, h - 102, 130, 50, Font::Large, kText,
                   Align::Right);
    renderer_.text(L"km/h", w - 88, h - 84, 70, 24, Font::Small, kDim);
    float nitro = static_cast<float>(std::clamp(rc.nitro / physics::kNitroMax, 0.0, 1.0));
    renderer_.text(L"NITRO", w - 224, h - 50, 60, 18, Font::Small, kDim);
    renderer_.fillRect(w - 164, h - 46, 140, 12, rgba(255, 255, 255, 40), 4);
    renderer_.fillRect(w - 164, h - 46, 140 * nitro, 12,
                       rc.nitroActive ? rgba(255, 140, 40) : rgba(56, 189, 248), 4);

    if (finished && net.phase() == MatchPhase::Racing) {
      renderer_.fillRect(w / 2 - 220, 80, 440, 56, kPanel, 8);
      renderer_.text(wfmt(L"FINISHED  P%d  %ls", rank, fmtTime(meta[slot].finishMs).c_str()),
                     w / 2 - 210, 80, 420, 56, Font::Medium, kGood, Align::Center, true, true);
    }
  }

  MatchPhase phase = net.phase();
  if (phase == MatchPhase::Waiting) {
    renderer_.text(L"Waiting for players...", w / 2 - 300, h * 0.22f, 600, 40, Font::Medium, kText,
                   Align::Center, true);
  } else if (phase == MatchPhase::Countdown || phase == MatchPhase::Racing) {
    int32_t start = net.raceStartTick();
    if (start != INT32_MAX) {
      int32_t left = start - tick;
      if (left > 0) {
        int n = (left + physics::kTickRate - 1) / physics::kTickRate;
        renderer_.text(wfmt(L"%d", n), w / 2 - 200, h / 2 - 140, 400, 160, Font::Huge,
                       n == 1 ? kAccent : kText, Align::Center, true, true);
      } else if (left > -physics::kTickRate) {
        renderer_.text(L"GO!", w / 2 - 300, h / 2 - 140, 600, 160, Font::Huge, kGood,
                       Align::Center, true, true);
      }
    }
  }
  if (phase == MatchPhase::Results || phase == MatchPhase::Ended || screen_ == Screen::Results) {
    renderer_.fillRect(0, 0, w, h, rgba(0, 0, 0, 90));
    drawResultsTable(w / 2 - 280, h * 0.16f, 560);
    if (screen_ == Screen::Results) {
      std::wstring sub =
          directMode_ && !config_.exitAfterRace
              ? std::wstring(L"Race over - press Enter to quit")
              : wfmt(L"Returning to the lobby in %.0f s (Enter)",
                     std::max(0.0, (8000 - (now - r.endedAt)) / 1000));
      renderer_.text(sub, w / 2 - 300, h - 70, 600, 30, Font::Normal, kDim, Align::Center, true);
    }
  }

  if (autopilot_) {
    renderer_.fillRect(w / 2 - 90, 14, 180, 28, rgba(30, 64, 175, 210), 6);
    renderer_.text(r.driver ? L"AUTOPILOT (F9)" : L"AUTOPILOT (preparing)", w / 2 - 90, 14, 180,
                   28, Font::Small, kText, Align::Center, false, true);
  }
  if (now - r.escAt < 2500)
    renderer_.text(L"Press Esc again to leave the race", w / 2 - 300, h - 120, 600, 30,
                   Font::Medium, kAccent, Align::Center, true);
  drawHints(L"F3 net  F4 ghosts  F5/F6 latency  F7 jitter  F8 loss  F9 autopilot  R respawn  "
            L"Esc leave");
}

void App::drawResultsTable(float x, float y, float w) {
  NetClient &net = *race_->net;
  const auto &meta = net.meta();
  struct Row {
    int position;
    int slot;
    bool finished;
    uint32_t total, best;
  };
  std::vector<Row> rows;
  for (const ResultEntry &e : net.results())
    rows.push_back({e.position, e.slot, e.finished, e.totalMs, e.bestLapMs});
  if (rows.empty())
    for (size_t i = 0; i < meta.size(); ++i)
      rows.push_back({meta[i].rank, static_cast<int>(i), meta[i].finished, meta[i].finishMs,
                      meta[i].bestLapMs});
  std::sort(rows.begin(), rows.end(), [](const Row &a, const Row &b) {
    int pa = a.position > 0 ? a.position : 999, pb = b.position > 0 ? b.position : 999;
    return pa < pb;
  });
  float rowH = 30;
  float h = 70 + rowH * static_cast<float>(rows.size());
  renderer_.fillRect(x, y, w, h, kPanelSolid, 10);
  renderer_.text(L"RESULTS", x, y + 8, w, 34, Font::Medium, kAccent, Align::Center);
  float hy = y + 44;
  renderer_.text(L"POS", x + 16, hy, 50, 20, Font::Small, kDim);
  renderer_.text(L"DRIVER", x + 70, hy, 200, 20, Font::Small, kDim);
  renderer_.text(L"TIME", x + 290, hy, 120, 20, Font::Small, kDim);
  renderer_.text(L"BEST LAP", x + 420, hy, 120, 20, Font::Small, kDim);
  float ry = y + 64;
  for (const Row &row : rows) {
    bool self = row.slot == net.slot();
    if (self) renderer_.fillRect(x + 6, ry - 2, w - 12, rowH - 2, kSelect, 4);
    std::string name = static_cast<size_t>(row.slot) < meta.size()
                           ? meta[row.slot].info.nickname +
                                 (meta[row.slot].info.bot ? std::string(" (bot)") : std::string())
                           : std::string("?");
    uint32_t color = static_cast<size_t>(row.slot) < meta.size()
                         ? parseColor(meta[row.slot].info.color, kText)
                         : kText;
    renderer_.fillRect(x + 56, ry + 6, 8, 14, color, 2);
    renderer_.text(row.position > 0 ? wfmt(L"%d", row.position) : std::wstring(L"-"), x + 16, ry,
                   40, rowH, Font::Normal, kText);
    renderer_.text(widen(name), x + 70, ry, 210, rowH, Font::Normal, kText);
    renderer_.text(row.finished ? fmtTime(row.total) : std::wstring(L"DNF"), x + 290, ry, 120,
                   rowH, Font::Normal, row.finished ? kText : kBad);
    renderer_.text(fmtTimeOrDash(row.best), x + 420, ry, 120, rowH, Font::Normal, kDim);
    ry += rowH;
  }
}

void App::drawNetOverlay() {
  float w = renderer_.uiWidth();
  std::vector<std::wstring> lines;
  NetConditions sim = config_.conditions;
  if (race_ && race_->started) {
    NetClient &net = *race_->net;
    auto s = net.stats();
    sim = s.conditions;
    lines.push_back(wfmt(L"state %hs  phase %hs  slot %d", netStateName(net.state()),
                         phaseName(net.phase()), net.slot()));
    lines.push_back(wfmt(L"rtt %.1f ms  jitter %.1f ms", s.rttMs, s.jitterMs));
    lines.push_back(wfmt(L"lead srv %d  target %.1f  scale %.4f", s.serverLead, s.targetLead,
                         s.timeScale));
    lines.push_back(wfmt(L"tick pred %d  srv %d  (+%d)", s.predictedTick, s.serverTick,
                         s.predictedTick - s.serverTick));
    lines.push_back(wfmt(L"resim %d ticks", s.lastResimTicks));
    lines.push_back(wfmt(L"snapshots %llu  gaps %llu", static_cast<unsigned long long>(s.snapshots),
                         static_cast<unsigned long long>(s.snapshotGaps)));
    lines.push_back(wfmt(L"inputs sent %llu", static_cast<unsigned long long>(s.inputsSent)));
    lines.push_back(wfmt(L"mispredict %llu  resyncs %llu",
                         static_cast<unsigned long long>(s.mispredictions),
                         static_cast<unsigned long long>(s.hardResyncs)));
    lines.push_back(wfmt(L"corr last %.2f avg %.2f max %.2f px", s.lastCorrectionPx,
                         s.avgCorrectionPx, s.maxCorrectionPx));
    lines.push_back(wfmt(L"in %.1f kbps  out %.1f kbps", s.bytesInPerSec * 8 / 1000,
                         s.bytesOutPerSec * 8 / 1000));
  } else {
    lines.push_back(L"not connected to a game server");
  }
  lines.push_back(wfmt(L"sim latency %d ms  jitter %d ms  loss %.0f%%", sim.latencyMs,
                       sim.jitterMs, sim.lossPercent));
  lines.push_back(wfmt(L"fps %.0f  autopilot %ls  ghosts %ls", fps_, autopilot_ ? L"on" : L"off",
                       showGhosts_ ? L"on" : L"off"));
  float lineH = 17;
  float panelW = 340, panelH = 16 + lineH * static_cast<float>(lines.size() + 1);
  float x = w - panelW - 14, y = 14;
  renderer_.fillRect(x, y, panelW, panelH, rgba(0, 0, 0, 185), 6);
  renderer_.text(L"NETWORK (F3)", x + 10, y + 6, panelW - 20, lineH, Font::Mono, kAccent);
  float ly = y + 6 + lineH;
  for (const auto &line : lines) {
    renderer_.text(line, x + 10, ly, panelW - 20, lineH, Font::Mono, rgba(200, 255, 200));
    ly += lineH;
  }
}

void App::drawToast(double now) {
  if (now >= toastUntil_ || toast_.empty()) return;
  float w = renderer_.uiWidth(), h = renderer_.uiHeight();
  float tw = std::min(w - 40, renderer_.textWidth(toast_, Font::Normal) + 40);
  renderer_.fillRect(w / 2 - tw / 2, h - 170, tw, 36, rgba(0, 0, 0, 200), 8);
  renderer_.text(toast_, w / 2 - tw / 2, h - 170, tw, 36, Font::Normal, kText, Align::Center,
                 false, true);
}

void App::drawHints(const std::wstring &hints) {
  float h = renderer_.uiHeight();
  renderer_.text(hints, 14, h - 24, renderer_.uiWidth() - 28, 20, Font::Small,
                 rgba(255, 255, 255, 170), Align::Left, true);
}

void App::drawMenuBackground() {
  float w = renderer_.uiWidth();
  renderer_.fillRect(0, 0, w, 64, rgba(20, 30, 44));
  renderer_.fillRect(0, 64, w, 3, kAccent);
  renderer_.text(L"CAR GAME", 24, 10, 300, 44, Font::Large, kText, Align::Left, false, true);
  if (!profile_.id.empty()) {
    std::wstring who = widen(profile_.nickname);
    float tw = renderer_.textWidth(who, Font::Normal);
    renderer_.fillRect(w - tw - 52, 22, 16, 22, parseColor(profile_.color, kText), 3);
    renderer_.text(who, w - tw - 28, 10, tw + 10, 44, Font::Normal, kText, Align::Left, false,
                   true);
  }
  if (autopilot_)
    renderer_.text(L"AI autopilot armed (F9)", w / 2 - 150, 10, 300, 44, Font::Small, kDim,
                   Align::Center, false, true);
}

void App::drawProfile() {
  float w = renderer_.uiWidth();
  float x = w / 2 - 280, y = 120;
  renderer_.fillRect(x, y, 560, 330, kPanelSolid, 12);
  renderer_.text(profile_.id.empty() ? L"Create your driver" : L"Edit your driver", x, y + 20, 560,
                 40, Font::Large, kText, Align::Center);
  renderer_.text(L"Nickname", x + 40, y + 90, 200, 24, Font::Normal, kDim);
  renderer_.fillRect(x + 40, y + 116, 480, 44, rgba(255, 255, 255, 25), 6);
  bool blink = static_cast<int>(nowMillis() / 500) % 2 == 0;
  renderer_.text(nicknameInput_ + (blink ? L"_" : L""), x + 54, y + 116, 450, 44, Font::Medium,
                 kText, Align::Left, false, true);
  renderer_.text(L"Color", x + 40, y + 176, 200, 24, Font::Normal, kDim);
  float cx = x + 40;
  for (int i = 0; i < kColorCount; ++i) {
    if (i == colorIndex_) renderer_.strokeRect(cx - 4, y + 200, 56, 56, kAccent, 3, 8);
    renderer_.fillRect(cx, y + 204, 48, 48, hexColor(kColors[i].rgb), 6);
    cx += 60;
  }
  renderer_.text(widen(kColors[colorIndex_].name), x + 40, y + 260, 480, 24, Font::Normal, kText,
                 Align::Center);
  if (!profileError_.empty())
    renderer_.text(profileError_, x, y + 290, 560, 24, Font::Normal, kBad, Align::Center);
  else if (profileBusy_)
    renderer_.text(L"Saving...", x, y + 290, 560, 24, Font::Normal, kDim, Align::Center);
  drawHints(L"Type nickname (2-16: a-z 0-9 _ -)   Left/Right color   Enter save   Esc " +
            std::wstring(profile_.id.empty() ? L"quit" : L"back"));
}

void App::drawBrowser() {
  float w = renderer_.uiWidth();
  float x = std::max(20.0f, w / 2 - 420), pw = std::min(w - 40, 840.0f), y = 90;
  renderer_.text(L"Lobbies", x, y, 400, 40, Font::Large, kText);
  renderer_.text(wfmt(L"%zu open", lobbies_.size()), x + pw - 200, y + 8, 200, 30, Font::Normal,
                 kDim, Align::Right);
  y += 50;
  renderer_.fillRect(x, y, pw, 32, rgba(255, 255, 255, 18), 4);
  renderer_.text(L"NAME", x + 14, y, 300, 32, Font::Small, kDim, Align::Left, false, true);
  renderer_.text(L"TRACK", x + 320, y, 240, 32, Font::Small, kDim, Align::Left, false, true);
  renderer_.text(L"LAPS", x + 560, y, 60, 32, Font::Small, kDim, Align::Left, false, true);
  renderer_.text(L"PLAYERS", x + 620, y, 90, 32, Font::Small, kDim, Align::Left, false, true);
  renderer_.text(L"STATUS", x + 720, y, 110, 32, Font::Small, kDim, Align::Left, false, true);
  y += 36;
  if (lobbies_.empty()) {
    renderer_.text(lobbiesPending_ ? L"Loading..." : L"No lobbies yet - press N to create one", x,
                   y + 20, pw, 30, Font::Normal, kDim, Align::Center);
  }
  for (size_t i = 0; i < lobbies_.size() && y < renderer_.uiHeight() - 80; ++i) {
    const Lobby &l = lobbies_[i];
    bool sel = static_cast<int>(i) == browserSel_;
    renderer_.fillRect(x, y, pw, 38, sel ? kSelect : rgba(255, 255, 255, 8), 4);
    renderer_.text(widen(l.name), x + 14, y, 300, 38, Font::Normal, kText, Align::Left, false,
                   true);
    renderer_.text(widen(l.trackName), x + 320, y, 240, 38, Font::Normal, kText, Align::Left,
                   false, true);
    renderer_.text(wfmt(L"%d", l.lapCount), x + 560, y, 60, 38, Font::Normal, kText, Align::Left,
                   false, true);
    renderer_.text(wfmt(L"%zu%ls", l.players.size(),
                        l.botCount ? wfmt(L" +%d bots", l.botCount).c_str() : L""),
                   x + 620, y, 100, 38, Font::Normal, kText, Align::Left, false, true);
    renderer_.text(widen(l.status), x + 720, y, 110, 38, Font::Normal,
                   l.status == "waiting" ? kGood : kAccent, Align::Left, false, true);
    y += 42;
  }
  if (actionPending_)
    renderer_.text(L"Please wait...", x, renderer_.uiHeight() - 60, pw, 30, Font::Normal, kAccent,
                   Align::Center);
  drawHints(L"Up/Down select   Enter join   N new lobby   R refresh   P profile   F9 autopilot   "
            L"Esc quit");
}

void App::drawCreate() {
  float w = renderer_.uiWidth();
  float x = w / 2 - 300, y = 120;
  renderer_.fillRect(x, y, 600, 330, kPanelSolid, 12);
  renderer_.text(L"New lobby", x, y + 20, 600, 40, Font::Large, kText, Align::Center);
  std::wstring trackName = tracks_.empty() ? (tracksPending_ ? L"loading..." : L"(no tracks)")
                                           : widen(tracks_[createTrack_].name);
  std::wstring rows[4] = {L"Track", L"Laps", L"Bots", L""};
  std::wstring values[4] = {trackName, wfmt(L"%d", createLaps_), wfmt(L"%d", createBots_),
                            actionPending_ ? L"Creating..." : L"Create lobby"};
  float ry = y + 90;
  for (int i = 0; i < 4; ++i) {
    bool sel = i == createRow_;
    renderer_.fillRect(x + 30, ry, 540, 44, sel ? kSelect : rgba(255, 255, 255, 12), 6);
    if (i < 3) {
      renderer_.text(rows[i], x + 46, ry, 120, 44, Font::Normal, kDim, Align::Left, false, true);
      renderer_.text(L"<  " + values[i] + L"  >", x + 160, ry, 400, 44, Font::Medium, kText,
                     Align::Center, false, true);
    } else {
      renderer_.text(values[i], x + 30, ry, 540, 44, Font::Medium, kAccent, Align::Center, false,
                     true);
    }
    ry += 52;
  }
  drawHints(L"Up/Down select   Left/Right change   Enter create   Esc back");
}

void App::drawRoom(double now) {
  float w = renderer_.uiWidth(), h = renderer_.uiHeight();
  float x = std::max(20.0f, w / 2 - 440), y = 84;
  renderer_.text(widen(lobby_.name), x, y, 600, 40, Font::Large, kText);
  std::wstring status = widen(lobby_.status);
  if (connectPending_ || (lobby_.hasConnection && lobby_.connection.matchId != consumedMatchId_))
    status = L"connecting";
  renderer_.text(status, x + 600, y + 6, 280, 30, Font::Medium,
                 lobby_.status == "waiting" ? kGood : kAccent, Align::Right);
  y += 50;

  if (now < roomBannerUntil_ && !roomBanner_.empty()) {
    renderer_.fillRect(x, y, 880, 40, rgba(127, 29, 29, 230), 6);
    renderer_.text(roomBanner_, x, y, 880, 40, Font::Medium, kText, Align::Center, false, true);
    y += 48;
  }
  if (!lobby_.message.empty()) {
    renderer_.fillRect(x, y, 880, 36, rgba(30, 58, 95, 230), 6);
    renderer_.text(widen(lobby_.message), x + 12, y, 856, 36, Font::Normal, kText, Align::Left,
                   false, true);
    y += 44;
  }

  // Settings.
  float sy = y;
  renderer_.fillRect(x, sy, 380, 190, kPanelSolid, 10);
  renderer_.text(L"SETTINGS", x + 16, sy + 10, 200, 22, Font::Small, kDim);
  bool host = isHost() && lobby_.status == "waiting";
  std::wstring labels[3] = {L"Track", L"Laps", L"Bots"};
  std::wstring values[3] = {widen(lobby_.trackName.empty() ? lobby_.trackId : lobby_.trackName),
                            wfmt(L"%d", lobby_.lapCount), wfmt(L"%d", lobby_.botCount)};
  float ry = sy + 40;
  for (int i = 0; i < 3; ++i) {
    if (host && i == roomRow_) renderer_.fillRect(x + 8, ry, 364, 40, kSelect, 5);
    renderer_.text(labels[i], x + 20, ry, 80, 40, Font::Normal, kDim, Align::Left, false, true);
    renderer_.text(host ? L"<  " + values[i] + L"  >" : values[i], x + 100, ry, 264, 40,
                   Font::Normal, kText, Align::Center, false, true);
    ry += 44;
  }
  bool trackReady = trackCache_.count(lobby_.trackId) > 0;
  renderer_.text(trackReady ? L"track downloaded" : L"downloading track...", x + 16, sy + 166,
                 340, 20, Font::Small, trackReady ? kDim : kAccent);

  // Players.
  float px = x + 400, pw = 480;
  float ph = 50 + 40 * static_cast<float>(std::max<size_t>(1, lobby_.players.size()));
  renderer_.fillRect(px, sy, pw, ph, kPanelSolid, 10);
  renderer_.text(wfmt(L"PLAYERS (%zu)%ls", lobby_.players.size(),
                      lobby_.botCount ? wfmt(L"  + %d bots", lobby_.botCount).c_str() : L""),
                 px + 16, sy + 10, 400, 22, Font::Small, kDim);
  float py = sy + 40;
  for (const LobbyPlayer &p : lobby_.players) {
    bool self = p.profileId == profile_.id;
    if (self) renderer_.fillRect(px + 8, py, pw - 16, 36, rgba(255, 255, 255, 18), 5);
    renderer_.fillRect(px + 18, py + 9, 12, 18, parseColor(p.color, kText), 3);
    std::wstring name = widen(p.nickname);
    if (p.profileId == lobby_.hostId) name += L"  (host)";
    renderer_.text(name, px + 42, py, 300, 36, Font::Normal, kText, Align::Left, false, true);
    renderer_.text(p.ready ? L"READY" : L"not ready", px + pw - 140, py, 120, 36, Font::Normal,
                   p.ready ? kGood : kDim, Align::Right, false, true);
    py += 40;
  }

  // Last race results.
  float ly = std::max(sy + 200, sy + ph + 10);
  if (!lobby_.lastResults.empty() && ly < h - 120) {
    renderer_.fillRect(x, ly, 880, 40 + 26 * static_cast<float>(lobby_.lastResults.size()),
                       kPanelSolid, 10);
    renderer_.text(L"LAST RACE", x + 16, ly + 10, 200, 22, Font::Small, kDim);
    float ey = ly + 34;
    for (const LobbyResultEntry &e : lobby_.lastResults) {
      if (ey > h - 60) break;
      renderer_.text(wfmt(L"%d.", e.position), x + 16, ey, 40, 24, Font::Normal, kText);
      renderer_.text(widen(e.nickname + (e.isBot ? " (bot)" : "")), x + 60, ey, 300, 24,
                     Font::Normal, kText);
      renderer_.text(e.finished ? fmtTime(e.totalMs) : std::wstring(L"DNF"), x + 380, ey, 160, 24,
                     Font::Normal, e.finished ? kText : kBad);
      renderer_.text(L"best " + fmtTimeOrDash(e.bestLapMs), x + 560, ey, 200, 24, Font::Normal,
                     kDim);
      ey += 26;
    }
  }

  std::wstring hints = L"Enter toggle ready   ";
  if (isHost()) hints += L"S start   Up/Down/Left/Right settings   ";
  hints += L"F9 autopilot   Esc leave";
  drawHints(hints);
}

void App::drawMessage() {
  float w = renderer_.uiWidth(), h = renderer_.uiHeight();
  renderer_.fillRect(w / 2 - 320, h / 2 - 90, 640, 180, kPanelSolid, 12);
  renderer_.text(message_.empty() ? L"Starting..." : message_, w / 2 - 300, h / 2 - 70, 600, 50,
                 Font::Medium, kText, Align::Center, false, true);
  renderer_.text(messageDetail_, w / 2 - 300, h / 2 - 10, 600, 80, Font::Normal, kDim,
                 Align::Center);
  drawHints(L"Esc quit");
}

} // namespace cgc

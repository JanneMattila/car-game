#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../common/botdriver.h"
#include "../common/clientnet.h"
#include "../common/lobbyapi.h"
#include "../common/racingline.h"
#include "input.h"
#include "renderer.h"
#include "trackmesh.h"

namespace cgc {

struct Config {
  std::string api = "http://localhost:3000";
  std::string nickname;
  std::string color;
  bool ai = false;
  cg::NetConditions conditions;
  std::string server, token, trackFile; // direct mode
  bool joinAny = false;
  std::string createTrack;
  bool autoReady = false;
  int startWhen = 0; // host starts automatically once this many players are ready (0 = off)
  int laps = 3;
  int bots = 0;
  bool exitAfterRace = false;
  std::string logFile;
  std::string logLevel;
  std::string profileFile;
};

// Returns false (and an error message) for invalid arguments.
bool parseArgs(const std::vector<std::string> &args, Config &config, std::string &error);
std::string usageText();
// %APPDATA%\CarGameNative (created on demand).
std::wstring appDataDir();

// Runs blocking REST calls on a background thread. A job runs on the worker with the worker's
// LobbyApi and returns a completion that is executed on the UI thread by drain().
class ApiWorker {
public:
  using Completion = std::function<void()>;
  using Job = std::function<Completion(cg::LobbyApi &)>;

  explicit ApiWorker(std::string baseUrl);
  ~ApiWorker();
  void post(Job job);
  void drain();
  bool idle() const;
  // Drops queued jobs, optionally runs one final job, and joins the thread.
  void stop(Job finalJob = nullptr);

private:
  void run();

  std::string baseUrl_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<Job> jobs_;
  std::vector<Completion> done_;
  bool stopping_ = false;
  bool running_ = false;
  std::thread thread_;
};

class App {
public:
  explicit App(Config config);
  ~App();

  bool init(HWND hwnd);
  void shutdown();
  // One iteration of the main loop: network update, API completions, rendering.
  void frame();
  void onResize(UINT width, UINT height);
  void onKey(int vk);
  void onChar(wchar_t ch);
  void setMinimized(bool minimized) { minimized_ = minimized; }
  bool wantsQuit() const { return quit_; }

private:
  enum class Screen { Startup, Profile, Browser, Create, Room, Race, Results, Message };

  struct RaceState {
    std::unique_ptr<cg::NetClient> net;
    bool started = false;
    std::string matchId;
    std::shared_ptr<const cg::Track> meshTrack;
    Mesh mesh;
    TrackMeshData meshData;
    std::future<std::shared_ptr<const cg::RacingLine>> lineFuture;
    std::shared_ptr<const cg::RacingLine> line;
    std::unique_ptr<cg::BotDriver> driver;
    bool driverNeedsReset = true;
    int lastLap = 0;
    int32_t lapStartTick = INT32_MAX;
    bool finishedLogged = false;
    double endedAt = 0;  // results shown at (ms)
    double failedAt = 0; // connection failure shown at (ms)
    std::wstring failMessage;
    double escAt = -1e9;
    cg::Vec2 camera;
    double zoom = 1;
    double lastFrameMs = 0;
    double lastStatsLogMs = 0;
    double aiSteer = 0;
  };

  // --- flow ---
  void startProfile();
  void submitProfile();
  void saveProfile();
  void enterBrowser();
  void enterRoom(const cg::Lobby &lobby);
  void leaveRoom();
  void startRace(const cg::Address &server, const std::string &token, const std::string &matchId);
  void endRace(bool backToRoom);
  void requestTracks();
  void prefetchTrack(const std::string &trackId);
  void pollLobbies();
  void pollRoom();
  void handleRoomUpdate(const cg::Lobby &lobby);
  void sendSettings(const std::string &trackId, int laps, int bots);
  void runAutoActions();
  void showError(const std::string &text);
  void showToast(const std::wstring &text, double seconds = 4);

  // --- race ---
  void updateRace(double now);
  cg::InputCmd sampleInput(int32_t tick, const cg::World &world, int slot);
  void applyConditions(const cg::NetConditions &conditions);
  std::shared_ptr<const cg::Track> resolveTrack(const std::string &trackId);
  void ensureTrackMesh();
  void setAutopilot(bool on);

  // --- drawing ---
  void render(double now);
  void drawWorld(double now);
  void drawRaceHud(double now);
  void drawResultsTable(float x, float y, float w);
  void drawNetOverlay();
  void drawMenuBackground();
  void drawProfile();
  void drawBrowser();
  void drawCreate();
  void drawRoom(double now);
  void drawMessage();
  void drawToast(double now);
  void drawHints(const std::wstring &hints);
  cg::Vec2 worldToUi(const cg::Vec2 &world) const;

  // --- keys per screen ---
  void keyProfile(int vk);
  void keyBrowser(int vk);
  void keyCreate(int vk);
  void keyRoom(int vk);
  void keyRace(int vk);

  bool isHost() const { return lobby_.hostId == profile_.id && !profile_.id.empty(); }
  const cg::LobbyPlayer *me() const;
  int trackIndex(const std::string &id) const;

  Config config_;
  HWND hwnd_ = nullptr;
  Renderer renderer_;
  InputDevices input_;
  std::unique_ptr<ApiWorker> api_;
  bool quit_ = false;
  bool minimized_ = false;
  bool directMode_ = false;

  Screen screen_ = Screen::Startup;
  std::wstring message_;      // Message/Startup screen text
  std::wstring messageDetail_;
  double retryAt_ = 0;

  // Profile.
  cg::Profile profile_;
  std::wstring profilePath_;
  std::wstring nicknameInput_;
  int colorIndex_ = 0;
  std::wstring profileError_;
  bool profileBusy_ = false;

  // Browser / create.
  std::vector<cg::Lobby> lobbies_;
  int browserSel_ = 0;
  bool lobbiesPending_ = false;
  double nextLobbyPoll_ = 0;
  std::vector<cg::TrackInfo> tracks_;
  bool tracksPending_ = false;
  int createTrack_ = 0, createLaps_ = 3, createBots_ = 0, createRow_ = 0;
  bool actionPending_ = false;
  bool autoJoinDone_ = false;

  // Room.
  cg::Lobby lobby_;
  bool inLobby_ = false;
  int lobbyGeneration_ = 0;
  bool roomPending_ = false;
  double nextRoomPoll_ = 0;
  int roomRow_ = 0;
  bool readyPending_ = false;
  bool startPending_ = false;
  std::string consumedMatchId_;
  bool connectPending_ = false;
  std::wstring roomBanner_;
  double roomBannerUntil_ = 0;
  int racesCompleted_ = 0;

  // Tracks.
  std::map<std::string, std::shared_ptr<const cg::Track>> trackCache_;
  std::map<std::string, bool> trackPending_;

  // Race.
  std::unique_ptr<RaceState> race_;
  bool autopilot_ = false;
  bool showNet_ = false;
  bool showGhosts_ = false;
  double steerVisual_ = 0;

  std::wstring toast_;
  double toastUntil_ = 0;
  double lastFrame_ = 0;
  double fps_ = 0;
  cg::Vec2 viewCenter_;
  double viewPpu_ = 1;
  int roomFailures_ = 0;
};

} // namespace cgc

// Native Windows game client: Direct3D 11 rendering, Direct2D/DirectWrite HUD and menus, lobby
// flow over the web server's REST API, and realtime racing through the UDP game server.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>

#include <string>
#include <vector>

#include "../common/log.h"
#include "../common/net.h"
#include "app.h"

namespace {

cgc::App *gApp = nullptr;
bool gFullscreen = false;
WINDOWPLACEMENT gPlacement{sizeof(WINDOWPLACEMENT)};
constexpr UINT_PTR kSizeMoveTimer = 1;

void toggleFullscreen(HWND hwnd) {
  DWORD style = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE));
  if (!gFullscreen) {
    MONITORINFO mi{sizeof(MONITORINFO)};
    if (GetWindowPlacement(hwnd, &gPlacement) &&
        GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY), &mi)) {
      SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_OVERLAPPEDWINDOW) | WS_POPUP);
      SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                   mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
                   SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
      gFullscreen = true;
    }
  } else {
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_POPUP) | WS_OVERLAPPEDWINDOW);
    SetWindowPlacement(hwnd, &gPlacement);
    SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    gFullscreen = false;
  }
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
  case WM_SIZE:
    if (gApp) {
      gApp->setMinimized(wParam == SIZE_MINIMIZED);
      if (wParam != SIZE_MINIMIZED) gApp->onResize(LOWORD(lParam), HIWORD(lParam));
    }
    return 0;
  case WM_ENTERSIZEMOVE: SetTimer(hwnd, kSizeMoveTimer, 1, nullptr); return 0;
  case WM_EXITSIZEMOVE: KillTimer(hwnd, kSizeMoveTimer); return 0;
  case WM_TIMER:
    // Keeps the game (and the network) running while the modal size/move loop is active.
    if (wParam == kSizeMoveTimer && gApp) gApp->frame();
    return 0;
  case WM_KEYDOWN:
  case WM_SYSKEYDOWN: {
    bool repeat = (lParam & (1 << 30)) != 0;
    int vk = static_cast<int>(wParam);
    if (vk == VK_F11 || (vk == VK_RETURN && msg == WM_SYSKEYDOWN)) {
      if (!repeat) toggleFullscreen(hwnd);
      return 0;
    }
    if (msg == WM_SYSKEYDOWN && vk != VK_F10) break;
    bool navigation = vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT;
    if (gApp && (!repeat || navigation)) gApp->onKey(vk);
    return 0;
  }
  case WM_CHAR:
    if (gApp) gApp->onChar(static_cast<wchar_t>(wParam));
    return 0;
  case WM_GETMINMAXINFO: {
    auto *info = reinterpret_cast<MINMAXINFO *>(lParam);
    info->ptMinTrackSize = {640, 400};
    return 0;
  }
  case WM_DPICHANGED: {
    const RECT *r = reinterpret_cast<const RECT *>(lParam);
    SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                 SWP_NOZORDER | SWP_NOACTIVATE);
    return 0;
  }
  case WM_ERASEBKGND: return 1;
  case WM_CLOSE: DestroyWindow(hwnd); return 0;
  case WM_DESTROY: PostQuitMessage(0); return 0;
  default: break;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

std::vector<std::string> commandLineArgs() {
  std::vector<std::string> args;
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return args;
  for (int i = 1; i < argc; ++i) args.push_back(cgc::narrow(argv[i]));
  LocalFree(argv);
  return args;
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int showCommand) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  cg::initPlatformTiming();

  cgc::Config config;
  std::vector<std::string> args = commandLineArgs();
  for (const std::string &a : args) {
    if (a == "--help" || a == "-h" || a == "/?") {
      MessageBoxW(nullptr, cgc::widen(cgc::usageText()).c_str(), L"cg_client", MB_OK);
      return 0;
    }
  }
  std::string error;
  if (!cgc::parseArgs(args, config, error)) {
    MessageBoxW(nullptr, cgc::widen(error + "\n\n" + cgc::usageText()).c_str(), L"cg_client",
                MB_OK | MB_ICONERROR);
    return 2;
  }

  std::string logFile = config.logFile.empty()
                            ? cgc::narrow(cgc::appDataDir() + L"\\client.log")
                            : config.logFile;
  cg::setLogFile(logFile);
  if (!config.logLevel.empty())
    cg::setLogLevel(cg::parseLogLevel(config.logLevel, cg::LogLevel::Info));
  cg::setLogPrefix((config.nickname.empty() ? std::string("client") : "client:" + config.nickname) +
                   " ");
  CG_INFO("cg_client starting (api %s%s%s)", config.api.c_str(),
          config.server.empty() ? "" : ", direct ", config.server.c_str());
  if (!cg::netInit()) {
    CG_ERROR("network initialisation failed");
    return 1;
  }

  WNDCLASSEXW wc{sizeof(WNDCLASSEXW)};
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = wndProc;
  wc.hInstance = instance;
  wc.hCursor = static_cast<HCURSOR>(
      LoadImageW(nullptr, MAKEINTRESOURCEW(32512), IMAGE_CURSOR, 0, 0, LR_DEFAULTSIZE | LR_SHARED));
  wc.hIcon = static_cast<HICON>(
      LoadImageW(nullptr, MAKEINTRESOURCEW(32512), IMAGE_ICON, 0, 0, LR_DEFAULTSIZE | LR_SHARED));
  wc.lpszClassName = L"CarGameNativeClient";
  RegisterClassExW(&wc);

  std::wstring title = L"Car Game";
  if (!config.nickname.empty()) title += L" - " + cgc::widen(config.nickname);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, title.c_str(), WS_OVERLAPPEDWINDOW,
                              CW_USEDEFAULT, CW_USEDEFAULT, 1280, 720, nullptr, nullptr, instance,
                              nullptr);
  if (!hwnd) {
    CG_ERROR("CreateWindow failed (%lu)", GetLastError());
    return 1;
  }
  // 1280x720 client area at the window's DPI.
  UINT dpi = GetDpiForWindow(hwnd);
  RECT rect{0, 0, MulDiv(1280, static_cast<int>(dpi), 96), MulDiv(720, static_cast<int>(dpi), 96)};
  AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);
  SetWindowPos(hwnd, nullptr, 0, 0, rect.right - rect.left, rect.bottom - rect.top,
               SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);

  int exitCode = 0;
  {
    cgc::App app(config);
    if (!app.init(hwnd)) {
      CG_ERROR("renderer initialisation failed");
      MessageBoxW(hwnd, L"Direct3D 11 initialisation failed.", L"cg_client", MB_ICONERROR);
      DestroyWindow(hwnd);
      return 1;
    }
    gApp = &app;
    ShowWindow(hwnd, showCommand == SW_HIDE ? SW_SHOWNORMAL : showCommand);
    UpdateWindow(hwnd);

    bool running = true;
    while (running) {
      MSG msg;
      while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        if (msg.message == WM_QUIT) {
          running = false;
          exitCode = static_cast<int>(msg.wParam);
          break;
        }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
      if (!running) break;
      if (app.wantsQuit()) {
        DestroyWindow(hwnd);
        continue;
      }
      app.frame();
    }
    gApp = nullptr;
    app.shutdown();
  }
  CG_INFO("cg_client exiting");
  return exitCode;
}

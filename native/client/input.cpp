#include "input.h"

#include <cmath>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <xinput.h>

#include "../common/log.h"

namespace cgc {

namespace {

bool down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

constexpr int kStickDeadzone = XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE;
constexpr uint8_t kTriggerThreshold = 30;

} // namespace

void InputDevices::poll(bool focused) {
  double now = cg::nowMillis();
  if (!padConnected_ && now < nextProbeMs_) return;
  XINPUT_STATE state{};
  if (XInputGetState(0, &state) != ERROR_SUCCESS) {
    if (padConnected_) CG_INFO("gamepad disconnected");
    padConnected_ = false;
    padButtons_ = prevButtons_ = 0;
    padLx_ = 0;
    padLt_ = padRt_ = 0;
    nextProbeMs_ = now + 2000; // probing a missing pad is slow; do it rarely
    return;
  }
  if (!padConnected_) CG_INFO("gamepad connected");
  padConnected_ = true;
  prevButtons_ = padButtons_;
  padButtons_ = state.Gamepad.wButtons;
  padLx_ = state.Gamepad.sThumbLX;
  padLt_ = state.Gamepad.bLeftTrigger;
  padRt_ = state.Gamepad.bRightTrigger;
  if (!focused) return;

  uint16_t pressed = static_cast<uint16_t>(padButtons_ & ~prevButtons_);
  struct Map {
    uint16_t button;
    int vk;
  };
  static const Map kMap[] = {
      {XINPUT_GAMEPAD_DPAD_UP, VK_UP},     {XINPUT_GAMEPAD_DPAD_DOWN, VK_DOWN},
      {XINPUT_GAMEPAD_DPAD_LEFT, VK_LEFT}, {XINPUT_GAMEPAD_DPAD_RIGHT, VK_RIGHT},
      {XINPUT_GAMEPAD_A, VK_RETURN},       {XINPUT_GAMEPAD_B, VK_ESCAPE},
      {XINPUT_GAMEPAD_START, VK_RETURN},   {XINPUT_GAMEPAD_BACK, VK_ESCAPE},
      {XINPUT_GAMEPAD_X, 'X'},
  };
  for (const Map &m : kMap)
    if (pressed & m.button) padKeys_.push_back(m.vk);
}

std::vector<int> InputDevices::takePadKeys() {
  std::vector<int> keys;
  keys.swap(padKeys_);
  return keys;
}

cg::InputCmd InputDevices::sample(bool focused) const {
  cg::InputCmd cmd;
  if (focused) {
    if (down('W') || down(VK_UP)) cmd.buttons |= cg::kInputAccelerate;
    if (down('S') || down(VK_DOWN)) cmd.buttons |= cg::kInputBrake;
    if (down('A') || down(VK_LEFT)) cmd.buttons |= cg::kInputLeft;
    if (down('D') || down(VK_RIGHT)) cmd.buttons |= cg::kInputRight;
    if (down(VK_SPACE) || down(VK_LSHIFT)) cmd.buttons |= cg::kInputNitro;
    if (down('R')) cmd.buttons |= cg::kInputRespawn;
  }
  if (focused && padConnected_) {
    if (padRt_ > kTriggerThreshold) cmd.buttons |= cg::kInputAccelerate;
    if (padLt_ > kTriggerThreshold) cmd.buttons |= cg::kInputBrake;
    if (padButtons_ & XINPUT_GAMEPAD_A) cmd.buttons |= cg::kInputNitro;
    if (padButtons_ & (XINPUT_GAMEPAD_B | XINPUT_GAMEPAD_Y)) cmd.buttons |= cg::kInputRespawn;
    if (padButtons_ & XINPUT_GAMEPAD_DPAD_LEFT) cmd.buttons |= cg::kInputLeft;
    if (padButtons_ & XINPUT_GAMEPAD_DPAD_RIGHT) cmd.buttons |= cg::kInputRight;
    int lx = padLx_;
    if (std::abs(lx) > kStickDeadzone && !(cmd.buttons & (cg::kInputLeft | cg::kInputRight))) {
      double magnitude = (std::abs(lx) - kStickDeadzone) / (32767.0 - kStickDeadzone);
      if (magnitude > 1) magnitude = 1;
      double value = (lx < 0 ? -1 : 1) * magnitude;
      int steer = static_cast<int>(std::lround(value * 127));
      if (steer == 0) steer = lx < 0 ? -1 : 1;
      cmd.steer = static_cast<int8_t>(steer);
    }
  }
  double target = cmd.steering();
  steerVisual_ += (target - steerVisual_) * 0.35;
  return cmd;
}

} // namespace cgc

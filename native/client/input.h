#pragma once

#include <cstdint>
#include <vector>

#include "../common/physics.h"

namespace cgc {

class InputDevices {
public:
  // Polls XInput (rate-limited when no pad is connected). Call once per frame.
  void poll(bool focused);
  // Builds the driving command from keyboard + gamepad state.
  cg::InputCmd sample(bool focused) const;
  // Visual steering amount in -1..1 for the front wheels.
  double steerVisual() const { return steerVisual_; }
  // Gamepad button edges converted to menu keys since the last call.
  std::vector<int> takePadKeys();
  bool padConnected() const { return padConnected_; }

private:
  bool padConnected_ = false;
  double nextProbeMs_ = 0;
  uint16_t padButtons_ = 0;
  uint16_t prevButtons_ = 0;
  int16_t padLx_ = 0;
  uint8_t padLt_ = 0, padRt_ = 0;
  std::vector<int> padKeys_;
  mutable double steerVisual_ = 0;
};

} // namespace cgc

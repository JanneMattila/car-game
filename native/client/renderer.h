#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <d2d1_1.h>
#include <d3d11.h>
#include <dwrite.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstdint>
#include <string>
#include <vector>

namespace cgc {

using Microsoft::WRL::ComPtr;

// World-space vertex: position in track pixels, color packed as RGBA8 (red in the low byte).
struct Vertex {
  float x, y;
  uint32_t color;
};

constexpr uint32_t rgba(uint32_t r, uint32_t g, uint32_t b, uint32_t a = 255) {
  return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
}
// 0xRRGGBB literal to packed color.
constexpr uint32_t hexColor(uint32_t rgb, uint32_t a = 255) {
  return rgba(rgb >> 16, rgb >> 8, rgb, a);
}
uint32_t withAlpha(uint32_t color, float alpha);
uint32_t mixColor(uint32_t a, uint32_t b, float t);
// Accepts "#rrggbb", "#rgb", or a car color name (red, blue, ...).
uint32_t parseColor(const std::string &text, uint32_t fallback);

// Static GPU vertex buffer (triangle list).
struct Mesh {
  ComPtr<ID3D11Buffer> buffer;
  UINT count = 0;
};

enum class Font { Small, Normal, Medium, Large, Huge, Mono, WorldLabel, WorldSmall, Count };
enum class Align { Left, Center, Right };

class Renderer {
public:
  bool init(HWND hwnd);
  void shutdown();
  void resize(UINT width, UINT height);
  UINT width() const { return width_; }
  UINT height() const { return height_; }
  bool deviceLost() const { return deviceLost_; }

  bool createMesh(const std::vector<Vertex> &vertices, Mesh &mesh);

  // --- 3D (well, 2D triangles) pass ---
  void beginFrame(uint32_t clearColor);
  // Camera: world point at the screen centre and screen pixels per world unit.
  void setView(double centerX, double centerY, double pixelsPerUnit);
  void drawMesh(const Mesh &mesh, UINT start, UINT count, double offsetX = 0, double offsetY = 0);
  void drawVertices(const std::vector<Vertex> &vertices, double offsetX = 0, double offsetY = 0);

  // --- Overlay (Direct2D) pass, coordinates in virtual UI units unless a transform is set ---
  void beginOverlay();
  void endFrame();
  // The UI is laid out in a virtual space with a height of ~720 units.
  float uiScale() const { return uiScale_; }
  float uiWidth() const { return width_ / uiScale_; }
  float uiHeight() const { return height_ / uiScale_; }
  void setUiTransform();
  // Transform mapping world coordinates to screen pixels, optionally combined with a local frame.
  void setWorldTransform(double originX, double originY, double rotation, double scale);

  void fillRect(float x, float y, float w, float h, uint32_t color, float radius = 0);
  void strokeRect(float x, float y, float w, float h, uint32_t color, float thickness = 1,
                  float radius = 0);
  void line(float x0, float y0, float x1, float y1, uint32_t color, float thickness = 1);
  void text(const std::wstring &text, float x, float y, float w, float h, Font font,
            uint32_t color, Align align = Align::Left, bool shadow = false,
            bool verticalCenter = false);
  float textWidth(const std::wstring &text, Font font);

private:
  bool createSizeDependent();
  void releaseSizeDependent();
  void bindPipeline();

  HWND hwnd_ = nullptr;
  UINT width_ = 0, height_ = 0;
  float uiScale_ = 1;
  bool deviceLost_ = false;
  UINT msaa_ = 1;
  UINT msaaQuality_ = 0;

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGISwapChain1> swapChain_;
  ComPtr<ID3D11Texture2D> msaaTarget_;
  ComPtr<ID3D11RenderTargetView> rtv_;
  ComPtr<ID3D11VertexShader> vs_;
  ComPtr<ID3D11PixelShader> ps_;
  ComPtr<ID3D11InputLayout> layout_;
  ComPtr<ID3D11Buffer> constants_;
  ComPtr<ID3D11BlendState> blend_;
  ComPtr<ID3D11RasterizerState> raster_;
  ComPtr<ID3D11Buffer> dynamic_;
  UINT dynamicCapacity_ = 0;

  ComPtr<ID2D1Factory1> d2dFactory_;
  ComPtr<ID2D1Device> d2dDevice_;
  ComPtr<ID2D1DeviceContext> d2d_;
  ComPtr<ID2D1Bitmap1> d2dTarget_;
  ComPtr<ID2D1SolidColorBrush> brush_;
  ComPtr<IDWriteFactory> dwrite_;
  ComPtr<IDWriteTextFormat> fonts_[static_cast<int>(Font::Count)];

  double viewX_ = 0, viewY_ = 0, ppu_ = 1;
  bool overlayActive_ = false;
};

} // namespace cgc

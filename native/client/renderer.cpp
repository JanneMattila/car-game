#include "renderer.h"

#include <d3dcompiler.h>

#include <algorithm>
#include <cmath>
#include <cstring>

#include "../common/log.h"

namespace cgc {

namespace {

const char *kShaderSource = R"(
cbuffer View : register(b0) {
  float4 transform; // xy = scale to clip space, zw = world offset (tile offset - camera)
};
struct VSIn { float2 pos : POSITION; float4 color : COLOR; };
struct VSOut { float4 pos : SV_Position; float4 color : COLOR; };
VSOut vsMain(VSIn input) {
  VSOut output;
  float2 p = (input.pos + transform.zw) * transform.xy;
  output.pos = float4(p, 0, 1);
  output.color = input.color;
  return output;
}
float4 psMain(VSOut input) : SV_Target { return input.color; }
)";

struct ViewConstants {
  float transform[4];
};

D2D1_COLOR_F toD2D(uint32_t c) {
  return D2D1::ColorF((c & 255) / 255.0f, ((c >> 8) & 255) / 255.0f, ((c >> 16) & 255) / 255.0f,
                      ((c >> 24) & 255) / 255.0f);
}

ComPtr<ID3DBlob> compile(const char *entry, const char *target) {
  ComPtr<ID3DBlob> code, errors;
  HRESULT hr = D3DCompile(kShaderSource, std::strlen(kShaderSource), "cg_client", nullptr, nullptr,
                          entry, target, D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &errors);
  if (FAILED(hr)) {
    CG_ERROR("shader %s failed: %s", entry,
             errors ? static_cast<const char *>(errors->GetBufferPointer()) : "unknown");
    return nullptr;
  }
  return code;
}

} // namespace

uint32_t withAlpha(uint32_t color, float alpha) {
  uint32_t a = static_cast<uint32_t>(std::clamp(alpha, 0.0f, 1.0f) * 255.0f + 0.5f);
  return (color & 0x00ffffffu) | (a << 24);
}

uint32_t mixColor(uint32_t a, uint32_t b, float t) {
  uint32_t out = 0;
  for (int shift = 0; shift < 32; shift += 8) {
    float ca = static_cast<float>((a >> shift) & 255), cb = static_cast<float>((b >> shift) & 255);
    out |= static_cast<uint32_t>(ca + (cb - ca) * t + 0.5f) << shift;
  }
  return out;
}

uint32_t parseColor(const std::string &text, uint32_t fallback) {
  struct Named {
    const char *name;
    uint32_t rgb;
  };
  static const Named names[] = {{"red", 0xDC2626},    {"blue", 0x1E40AF},  {"black", 0x171717},
                                {"white", 0xF5F5F4},  {"silver", 0x9CA3AF}, {"green", 0x15803D},
                                {"yellow", 0xEAB308}, {"orange", 0xEA580C}};
  for (const Named &n : names)
    if (_stricmp(n.name, text.c_str()) == 0) return hexColor(n.rgb);
  if (text.size() >= 4 && text[0] == '#') {
    std::string digits = text.substr(1);
    if (digits.size() == 3) digits = {digits[0], digits[0], digits[1], digits[1], digits[2], digits[2]};
    if (digits.size() >= 6) {
      char *end = nullptr;
      unsigned long value = std::strtoul(digits.substr(0, 6).c_str(), &end, 16);
      if (end && *end == 0) return hexColor(static_cast<uint32_t>(value));
    }
  }
  return fallback;
}

bool Renderer::init(HWND hwnd) {
  hwnd_ = hwnd;
  RECT rc;
  GetClientRect(hwnd, &rc);
  width_ = static_cast<UINT>(std::max<LONG>(1, rc.right - rc.left));
  height_ = static_cast<UINT>(std::max<LONG>(1, rc.bottom - rc.top));

  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
                                D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  D3D_FEATURE_LEVEL got;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels,
                                 ARRAYSIZE(levels), D3D11_SDK_VERSION, &device_, &got, &context_);
  if (FAILED(hr)) {
    CG_WARN("hardware D3D11 device unavailable (0x%08lx), using WARP", static_cast<unsigned long>(hr));
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, levels,
                           ARRAYSIZE(levels), D3D11_SDK_VERSION, &device_, &got, &context_);
  }
  if (FAILED(hr)) {
    CG_ERROR("D3D11CreateDevice failed 0x%08lx", static_cast<unsigned long>(hr));
    return false;
  }

  ComPtr<IDXGIDevice> dxgiDevice;
  device_.As(&dxgiDevice);
  ComPtr<IDXGIAdapter> adapter;
  dxgiDevice->GetAdapter(&adapter);
  DXGI_ADAPTER_DESC adapterDesc{};
  adapter->GetDesc(&adapterDesc);
  char adapterName[128];
  WideCharToMultiByte(CP_UTF8, 0, adapterDesc.Description, -1, adapterName, sizeof(adapterName),
                      nullptr, nullptr);
  CG_INFO("D3D11 device: %s (feature level 0x%x)", adapterName, static_cast<unsigned>(got));
  ComPtr<IDXGIFactory2> factory;
  adapter->GetParent(IID_PPV_ARGS(&factory));

  for (UINT samples : {4u, 2u}) {
    UINT quality = 0;
    if (SUCCEEDED(device_->CheckMultisampleQualityLevels(DXGI_FORMAT_B8G8R8A8_UNORM, samples,
                                                         &quality)) &&
        quality > 0) {
      msaa_ = samples;
      msaaQuality_ = 0;
      break;
    }
  }

  DXGI_SWAP_CHAIN_DESC1 desc{};
  desc.Width = width_;
  desc.Height = height_;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 2;
  desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  desc.Scaling = DXGI_SCALING_STRETCH;
  desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
  hr = factory->CreateSwapChainForHwnd(device_.Get(), hwnd, &desc, nullptr, nullptr, &swapChain_);
  if (FAILED(hr)) {
    // Very old systems: fall back to the sequential flip model.
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    hr = factory->CreateSwapChainForHwnd(device_.Get(), hwnd, &desc, nullptr, nullptr,
                                         &swapChain_);
  }
  if (FAILED(hr)) {
    CG_ERROR("CreateSwapChainForHwnd failed 0x%08lx", static_cast<unsigned long>(hr));
    return false;
  }
  factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER);

  auto vsCode = compile("vsMain", "vs_4_0");
  auto psCode = compile("psMain", "ps_4_0");
  if (!vsCode || !psCode) return false;
  device_->CreateVertexShader(vsCode->GetBufferPointer(), vsCode->GetBufferSize(), nullptr, &vs_);
  device_->CreatePixelShader(psCode->GetBufferPointer(), psCode->GetBufferSize(), nullptr, &ps_);
  D3D11_INPUT_ELEMENT_DESC elements[] = {
      {"POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0},
      {"COLOR", 0, DXGI_FORMAT_R8G8B8A8_UNORM, 0, 8, D3D11_INPUT_PER_VERTEX_DATA, 0},
  };
  device_->CreateInputLayout(elements, 2, vsCode->GetBufferPointer(), vsCode->GetBufferSize(),
                             &layout_);

  D3D11_BUFFER_DESC cb{};
  cb.ByteWidth = sizeof(ViewConstants);
  cb.Usage = D3D11_USAGE_DYNAMIC;
  cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  cb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  device_->CreateBuffer(&cb, nullptr, &constants_);

  D3D11_BLEND_DESC bd{};
  auto &rt = bd.RenderTarget[0];
  rt.BlendEnable = TRUE;
  rt.SrcBlend = D3D11_BLEND_SRC_ALPHA;
  rt.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
  rt.BlendOp = D3D11_BLEND_OP_ADD;
  rt.SrcBlendAlpha = D3D11_BLEND_ONE;
  rt.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
  rt.BlendOpAlpha = D3D11_BLEND_OP_ADD;
  rt.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
  device_->CreateBlendState(&bd, &blend_);

  D3D11_RASTERIZER_DESC rd{};
  rd.FillMode = D3D11_FILL_SOLID;
  rd.CullMode = D3D11_CULL_NONE;
  rd.DepthClipEnable = TRUE;
  rd.MultisampleEnable = msaa_ > 1;
  device_->CreateRasterizerState(&rd, &raster_);

  // Direct2D / DirectWrite on the same device for text and HUD.
  D2D1_FACTORY_OPTIONS options{};
  hr = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, __uuidof(ID2D1Factory1), &options,
                         reinterpret_cast<void **>(d2dFactory_.GetAddressOf()));
  if (FAILED(hr) || FAILED(d2dFactory_->CreateDevice(dxgiDevice.Get(), &d2dDevice_)) ||
      FAILED(d2dDevice_->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, &d2d_))) {
    CG_ERROR("Direct2D initialisation failed");
    return false;
  }
  d2d_->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
  d2d_->CreateSolidColorBrush(D2D1::ColorF(1, 1, 1, 1), &brush_);
  hr = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                           reinterpret_cast<IUnknown **>(dwrite_.GetAddressOf()));
  if (FAILED(hr)) {
    CG_ERROR("DirectWrite initialisation failed");
    return false;
  }
  struct FontSpec {
    const wchar_t *family;
    float size;
    DWRITE_FONT_WEIGHT weight;
  };
  const FontSpec specs[] = {
      {L"Segoe UI", 13, DWRITE_FONT_WEIGHT_NORMAL},    {L"Segoe UI", 16, DWRITE_FONT_WEIGHT_NORMAL},
      {L"Segoe UI", 22, DWRITE_FONT_WEIGHT_SEMI_BOLD}, {L"Segoe UI", 34, DWRITE_FONT_WEIGHT_BOLD},
      {L"Segoe UI", 110, DWRITE_FONT_WEIGHT_BLACK},    {L"Consolas", 13, DWRITE_FONT_WEIGHT_NORMAL},
      {L"Segoe UI", 28, DWRITE_FONT_WEIGHT_SEMI_BOLD}, {L"Segoe UI", 14, DWRITE_FONT_WEIGHT_NORMAL},
  };
  for (int i = 0; i < static_cast<int>(Font::Count); ++i) {
    dwrite_->CreateTextFormat(specs[i].family, nullptr, specs[i].weight, DWRITE_FONT_STYLE_NORMAL,
                              DWRITE_FONT_STRETCH_NORMAL, specs[i].size, L"en-us", &fonts_[i]);
    fonts_[i]->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
  }
  return createSizeDependent();
}

void Renderer::shutdown() {
  if (context_) context_->ClearState();
  releaseSizeDependent();
}

bool Renderer::createSizeDependent() {
  ComPtr<ID3D11Texture2D> backBuffer;
  HRESULT hr = swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
  if (FAILED(hr)) return false;
  if (msaa_ > 1) {
    D3D11_TEXTURE2D_DESC td{};
    td.Width = width_;
    td.Height = height_;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = msaa_;
    td.SampleDesc.Quality = msaaQuality_;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET;
    hr = device_->CreateTexture2D(&td, nullptr, &msaaTarget_);
    if (FAILED(hr)) return false;
    hr = device_->CreateRenderTargetView(msaaTarget_.Get(), nullptr, &rtv_);
  } else {
    hr = device_->CreateRenderTargetView(backBuffer.Get(), nullptr, &rtv_);
  }
  if (FAILED(hr)) return false;

  ComPtr<IDXGISurface> surface;
  swapChain_->GetBuffer(0, IID_PPV_ARGS(&surface));
  D2D1_BITMAP_PROPERTIES1 props = D2D1::BitmapProperties1(
      D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
      D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE), 96, 96);
  hr = d2d_->CreateBitmapFromDxgiSurface(surface.Get(), &props, &d2dTarget_);
  if (FAILED(hr)) {
    CG_ERROR("CreateBitmapFromDxgiSurface failed 0x%08lx", static_cast<unsigned long>(hr));
    return false;
  }
  d2d_->SetTarget(d2dTarget_.Get());
  uiScale_ = std::clamp(height_ / 720.0f, 0.6f, 3.0f);
  return true;
}

void Renderer::releaseSizeDependent() {
  if (d2d_) d2d_->SetTarget(nullptr);
  d2dTarget_.Reset();
  rtv_.Reset();
  msaaTarget_.Reset();
  if (context_) {
    context_->OMSetRenderTargets(0, nullptr, nullptr);
    context_->Flush();
  }
}

void Renderer::resize(UINT width, UINT height) {
  if (!swapChain_ || width == 0 || height == 0) return;
  if (width == width_ && height == height_) return;
  width_ = width;
  height_ = height;
  releaseSizeDependent();
  HRESULT hr = swapChain_->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, 0);
  if (FAILED(hr)) {
    CG_ERROR("ResizeBuffers failed 0x%08lx", static_cast<unsigned long>(hr));
    deviceLost_ = true;
    return;
  }
  if (!createSizeDependent()) deviceLost_ = true;
}

bool Renderer::createMesh(const std::vector<Vertex> &vertices, Mesh &mesh) {
  mesh = Mesh{};
  if (vertices.empty()) return true;
  D3D11_BUFFER_DESC bd{};
  bd.ByteWidth = static_cast<UINT>(vertices.size() * sizeof(Vertex));
  bd.Usage = D3D11_USAGE_IMMUTABLE;
  bd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
  D3D11_SUBRESOURCE_DATA data{vertices.data(), 0, 0};
  if (FAILED(device_->CreateBuffer(&bd, &data, &mesh.buffer))) return false;
  mesh.count = static_cast<UINT>(vertices.size());
  return true;
}

void Renderer::bindPipeline() {
  D3D11_VIEWPORT vp{0, 0, static_cast<float>(width_), static_cast<float>(height_), 0, 1};
  context_->RSSetViewports(1, &vp);
  context_->RSSetState(raster_.Get());
  context_->OMSetRenderTargets(1, rtv_.GetAddressOf(), nullptr);
  float factor[4] = {0, 0, 0, 0};
  context_->OMSetBlendState(blend_.Get(), factor, 0xffffffff);
  context_->IASetInputLayout(layout_.Get());
  context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  context_->VSSetShader(vs_.Get(), nullptr, 0);
  context_->VSSetConstantBuffers(0, 1, constants_.GetAddressOf());
  context_->PSSetShader(ps_.Get(), nullptr, 0);
}

void Renderer::beginFrame(uint32_t clearColor) {
  bindPipeline();
  D2D1_COLOR_F c = toD2D(clearColor);
  float color[4] = {c.r, c.g, c.b, 1};
  context_->ClearRenderTargetView(rtv_.Get(), color);
}

void Renderer::setView(double centerX, double centerY, double pixelsPerUnit) {
  viewX_ = centerX;
  viewY_ = centerY;
  ppu_ = pixelsPerUnit;
}

namespace {
void writeConstants(ID3D11DeviceContext *context, ID3D11Buffer *buffer, const ViewConstants &v) {
  D3D11_MAPPED_SUBRESOURCE mapped;
  if (SUCCEEDED(context->Map(buffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) {
    std::memcpy(mapped.pData, &v, sizeof(v));
    context->Unmap(buffer, 0);
  }
}
} // namespace

void Renderer::drawMesh(const Mesh &mesh, UINT start, UINT count, double offsetX, double offsetY) {
  if (!mesh.buffer || count == 0) return;
  ViewConstants v{{static_cast<float>(2 * ppu_ / width_), static_cast<float>(-2 * ppu_ / height_),
                   static_cast<float>(offsetX - viewX_), static_cast<float>(offsetY - viewY_)}};
  writeConstants(context_.Get(), constants_.Get(), v);
  UINT stride = sizeof(Vertex), offset = 0;
  context_->IASetVertexBuffers(0, 1, mesh.buffer.GetAddressOf(), &stride, &offset);
  context_->Draw(count, start);
}

void Renderer::drawVertices(const std::vector<Vertex> &vertices, double offsetX, double offsetY) {
  if (vertices.empty()) return;
  UINT bytes = static_cast<UINT>(vertices.size() * sizeof(Vertex));
  if (bytes > dynamicCapacity_) {
    dynamic_.Reset();
    D3D11_BUFFER_DESC bd{};
    bd.ByteWidth = std::max<UINT>(bytes * 2, 64 * 1024);
    bd.Usage = D3D11_USAGE_DYNAMIC;
    bd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
    bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    if (FAILED(device_->CreateBuffer(&bd, nullptr, &dynamic_))) return;
    dynamicCapacity_ = bd.ByteWidth;
  }
  D3D11_MAPPED_SUBRESOURCE mapped;
  if (FAILED(context_->Map(dynamic_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) return;
  std::memcpy(mapped.pData, vertices.data(), bytes);
  context_->Unmap(dynamic_.Get(), 0);
  ViewConstants v{{static_cast<float>(2 * ppu_ / width_), static_cast<float>(-2 * ppu_ / height_),
                   static_cast<float>(offsetX - viewX_), static_cast<float>(offsetY - viewY_)}};
  writeConstants(context_.Get(), constants_.Get(), v);
  UINT stride = sizeof(Vertex), offset = 0;
  context_->IASetVertexBuffers(0, 1, dynamic_.GetAddressOf(), &stride, &offset);
  context_->Draw(static_cast<UINT>(vertices.size()), 0);
}

void Renderer::beginOverlay() {
  if (msaa_ > 1) {
    ComPtr<ID3D11Texture2D> backBuffer;
    swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
    context_->ResolveSubresource(backBuffer.Get(), 0, msaaTarget_.Get(), 0,
                                 DXGI_FORMAT_B8G8R8A8_UNORM);
  }
  context_->OMSetRenderTargets(0, nullptr, nullptr);
  d2d_->BeginDraw();
  overlayActive_ = true;
  setUiTransform();
}

void Renderer::endFrame() {
  if (overlayActive_) {
    HRESULT hr = d2d_->EndDraw();
    overlayActive_ = false;
    if (hr == D2DERR_RECREATE_TARGET) deviceLost_ = true;
  }
  HRESULT hr = swapChain_->Present(1, 0);
  if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) {
    CG_ERROR("graphics device lost (0x%08lx)", static_cast<unsigned long>(hr));
    deviceLost_ = true;
  }
}

void Renderer::setUiTransform() { d2d_->SetTransform(D2D1::Matrix3x2F::Scale(uiScale_, uiScale_)); }

void Renderer::setWorldTransform(double originX, double originY, double rotation, double scale) {
  // local -> world: rotate, scale, translate to origin; world -> screen: camera.
  double c = std::cos(rotation) * scale, s = std::sin(rotation) * scale;
  double tx = (originX - viewX_) * ppu_ + width_ / 2.0;
  double ty = (originY - viewY_) * ppu_ + height_ / 2.0;
  D2D1_MATRIX_3X2_F m;
  m._11 = static_cast<float>(c * ppu_);
  m._12 = static_cast<float>(s * ppu_);
  m._21 = static_cast<float>(-s * ppu_);
  m._22 = static_cast<float>(c * ppu_);
  m._31 = static_cast<float>(tx);
  m._32 = static_cast<float>(ty);
  d2d_->SetTransform(m);
}

void Renderer::fillRect(float x, float y, float w, float h, uint32_t color, float radius) {
  brush_->SetColor(toD2D(color));
  D2D1_RECT_F r = D2D1::RectF(x, y, x + w, y + h);
  if (radius > 0) d2d_->FillRoundedRectangle(D2D1::RoundedRect(r, radius, radius), brush_.Get());
  else d2d_->FillRectangle(r, brush_.Get());
}

void Renderer::strokeRect(float x, float y, float w, float h, uint32_t color, float thickness,
                          float radius) {
  brush_->SetColor(toD2D(color));
  D2D1_RECT_F r = D2D1::RectF(x, y, x + w, y + h);
  if (radius > 0)
    d2d_->DrawRoundedRectangle(D2D1::RoundedRect(r, radius, radius), brush_.Get(), thickness);
  else d2d_->DrawRectangle(r, brush_.Get(), thickness);
}

void Renderer::line(float x0, float y0, float x1, float y1, uint32_t color, float thickness) {
  brush_->SetColor(toD2D(color));
  d2d_->DrawLine(D2D1::Point2F(x0, y0), D2D1::Point2F(x1, y1), brush_.Get(), thickness);
}

void Renderer::text(const std::wstring &str, float x, float y, float w, float h, Font font,
                    uint32_t color, Align align, bool shadow, bool verticalCenter) {
  IDWriteTextFormat *format = fonts_[static_cast<int>(font)].Get();
  if (!format || str.empty()) return;
  format->SetTextAlignment(align == Align::Left     ? DWRITE_TEXT_ALIGNMENT_LEADING
                           : align == Align::Center ? DWRITE_TEXT_ALIGNMENT_CENTER
                                                    : DWRITE_TEXT_ALIGNMENT_TRAILING);
  format->SetParagraphAlignment(verticalCenter ? DWRITE_PARAGRAPH_ALIGNMENT_CENTER
                                               : DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
  UINT32 length = static_cast<UINT32>(str.size());
  if (shadow) {
    float offset = font == Font::Huge ? 4.0f : 1.5f;
    brush_->SetColor(D2D1::ColorF(0, 0, 0, 0.75f * (((color >> 24) & 255) / 255.0f)));
    d2d_->DrawText(str.c_str(), length, format,
                   D2D1::RectF(x + offset, y + offset, x + w + offset, y + h + offset),
                   brush_.Get(), D2D1_DRAW_TEXT_OPTIONS_CLIP);
  }
  brush_->SetColor(toD2D(color));
  d2d_->DrawText(str.c_str(), length, format, D2D1::RectF(x, y, x + w, y + h), brush_.Get(),
                 D2D1_DRAW_TEXT_OPTIONS_CLIP);
}

float Renderer::textWidth(const std::wstring &str, Font font) {
  ComPtr<IDWriteTextLayout> layout;
  if (FAILED(dwrite_->CreateTextLayout(str.c_str(), static_cast<UINT32>(str.size()),
                                       fonts_[static_cast<int>(font)].Get(), 10000, 1000,
                                       &layout)))
    return 0;
  DWRITE_TEXT_METRICS metrics{};
  layout->GetMetrics(&metrics);
  return metrics.widthIncludingTrailingWhitespace;
}

} // namespace cgc

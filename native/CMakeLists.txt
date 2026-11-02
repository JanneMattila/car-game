cmake_minimum_required(VERSION 3.20)
project(car_game_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(CG_BUILD_CLIENT "Build the DirectX 11 game client (Windows only)" ${WIN32})
option(CG_BUILD_TESTS "Build native tests" ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

if(MSVC)
  add_compile_options(/W4 /permissive- /utf-8 /MP)
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
  # The simulation must give identical results on every machine: no fused or reordered math.
  add_compile_options(/fp:precise)
else()
  add_compile_options(-Wall -Wextra -ffp-contract=off)
endif()

set(CG_TRACK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../data/tracks")

add_library(cg_common STATIC
  common/json.cpp
  common/log.cpp
  common/track.cpp
  common/physics.cpp
  common/protocol.cpp
  common/net.cpp
  common/clientnet.cpp
  common/http.cpp
  common/lobbyapi.cpp
  common/racingline.cpp
  common/botdriver.cpp
)
target_include_directories(cg_common PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
find_package(Threads REQUIRED)
target_link_libraries(cg_common PUBLIC Threads::Threads)
if(WIN32)
  target_link_libraries(cg_common PUBLIC ws2_32 winmm)
endif()

add_library(cg_match STATIC server/match.cpp)
target_link_libraries(cg_match PUBLIC cg_common)

add_executable(cg_server server/main.cpp)
target_link_libraries(cg_server PRIVATE cg_match)

add_executable(cg_bot bot/main.cpp)
target_link_libraries(cg_bot PRIVATE cg_common)

if(WIN32 AND CG_BUILD_CLIENT)
  add_executable(cg_client WIN32
    client/main.cpp
    client/app.cpp
    client/renderer.cpp
    client/trackmesh.cpp
    client/input.cpp
  )
  target_link_libraries(cg_client PRIVATE cg_common d3d11 dxgi d3dcompiler d2d1 dwrite xinput)
endif()

if(CG_BUILD_TESTS)
  enable_testing()
  add_executable(cg_unit_test tests/unit_test.cpp)
  target_link_libraries(cg_unit_test PRIVATE cg_common)
  add_executable(cg_ai_test tests/ai_test.cpp)
  target_link_libraries(cg_ai_test PRIVATE cg_common)
  add_executable(cg_loopback_test tests/loopback_test.cpp)
  target_link_libraries(cg_loopback_test PRIVATE cg_match)

  add_test(NAME unit COMMAND cg_unit_test ${CG_TRACK_DIR}/bristol-short-oval.json)
  add_test(NAME ai COMMAND cg_ai_test --laps 2
    ${CG_TRACK_DIR}/bristol-short-oval.json
    ${CG_TRACK_DIR}/monaco-grand-prix.json
    ${CG_TRACK_DIR}/track-1769970584891.json)
  add_test(NAME loopback COMMAND cg_loopback_test ${CG_TRACK_DIR}/bristol-short-oval.json)
  set_tests_properties(loopback PROPERTIES TIMEOUT 300)
endif()

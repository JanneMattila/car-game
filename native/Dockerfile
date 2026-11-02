# Dedicated UDP game server (cg_server) built with g++.
# Build from the repository root so the tests can read data/tracks:
#   docker build -f native/Dockerfile -t car-game-server .
#   docker run --rm -i -p 5555:5555/udp car-game-server --config - < match.json

FROM gcc:14-bookworm AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends cmake ninja-build \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY native ./native
COPY data/tracks ./data/tracks
RUN cmake -S native -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCG_BUILD_CLIENT=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
  && cmake --build /build \
  && ctest --test-dir /build --output-on-failure

FROM debian:bookworm-slim AS runtime
RUN useradd --system --no-create-home gameserver
COPY --from=build /build/cg_server /usr/local/bin/cg_server
COPY --from=build /build/cg_bot /usr/local/bin/cg_bot
USER gameserver
EXPOSE 5555/udp
ENTRYPOINT ["/usr/local/bin/cg_server"]
CMD ["--help"]

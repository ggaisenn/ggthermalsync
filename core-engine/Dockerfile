FROM debian:bookworm-slim AS build

RUN apt-get update \
    && apt-get install --no-install-recommends -y cmake g++ make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY core-engine/ ./
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --target BATTERYSIM --parallel

FROM debian:bookworm-slim AS runtime
RUN useradd --system --create-home --uid 10001 simulator
COPY --from=build /src/build/BATTERYSIM /usr/local/bin/BATTERYSIM
USER simulator
ENTRYPOINT ["/usr/local/bin/BATTERYSIM"]

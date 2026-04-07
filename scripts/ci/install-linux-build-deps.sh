#!/usr/bin/env bash

set -euo pipefail

# Keep Linux release builds aligned with the native deps required by selection-hook.
sudo apt-get update
sudo apt-get install -y \
  rpm \
  libevdev-dev \
  libxtst-dev \
  libx11-dev \
  libxfixes-dev \
  libwayland-dev

#!/bin/bash
# Build the vendored step-26 Vulkan host.
# Mirrors the spike session build line (gcc -O2 ... -lvulkan -lm).
set -euo pipefail
cd "$(dirname "$0")"
(cd shaders && sha256sum -c MANIFEST.sha256 > /dev/null) && echo "shader manifest: OK"
gcc -O2 -o vkrunner_s26 host/vkrunner_s26.c -lvulkan -lm
echo "built: gpu/vkrunner_s26"
gcc -O3 -o ../persistent/pfserve ../persistent/pfserve.c -lvulkan -lm
echo "built: persistent/pfserve"

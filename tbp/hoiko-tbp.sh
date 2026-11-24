#!/bin/sh
# TBP entry point for Hoiko (Rust/WASM replica), used as intetrigence
# external-arena --opponent. Configuration: see tbp/hoiko-tbp.ts header.
exec bun "$(dirname "$0")/hoiko-tbp.ts"

#!/bin/sh
# TBP entry point for Attax (used as intetrigence external-arena --opponent).
exec bun "$(dirname "$0")/attax-tbp.ts"

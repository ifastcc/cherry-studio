#!/usr/bin/env bash

set -euo pipefail

attempts=3
delay_seconds=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --attempts)
      attempts="$2"
      shift 2
      ;;
    --delay)
      delay_seconds="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 [--attempts N] [--delay SECONDS] -- command [args...]"
  exit 64
fi

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid attempt count: $attempts"
  exit 64
fi

if ! [[ "$delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "Invalid retry delay: $delay_seconds"
  exit 64
fi

for attempt in $(seq 1 "$attempts"); do
  set +e
  "$@"
  exit_code=$?
  set -e

  if [[ "$exit_code" -eq 0 ]]; then
    exit 0
  fi

  if [[ "$attempt" -eq "$attempts" ]]; then
    echo "Command failed after ${attempts} attempt(s)."
    exit "$exit_code"
  fi

  echo "Command failed with exit code ${exit_code}. Retrying in ${delay_seconds}s (${attempt}/${attempts})..."
  sleep "$delay_seconds"
done

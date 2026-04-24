#!/usr/bin/env bash

set -euo pipefail

CONFIG_SELECTOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGS_DIR="${CONFIG_SELECTOR_DIR}/configs"

list_config_files() {
  if [[ ! -d "${CONFIGS_DIR}" ]]; then
    return 0
  fi
  find "${CONFIGS_DIR}" -maxdepth 1 -type f -name "*.env" | sort
}

select_config_interactively() {
  local configs=()
  while IFS= read -r config_path; do
    [[ -n "${config_path}" ]] && configs+=("${config_path}")
  done < <(list_config_files)

  if [[ ${#configs[@]} -eq 0 ]]; then
    echo "No config files found in ${CONFIGS_DIR}" >&2
    return 1
  fi

  echo "Select packaging config:" >&2
  local index=1
  local config_name
  for config_path in "${configs[@]}"; do
    config_name="$(basename "${config_path}")"
    printf "  %d) %s\n" "${index}" "${config_name}" >&2
    index=$((index + 1))
  done

  local selection
  while true; do
    printf "Enter selection [1-%d]: " "${#configs[@]}" >&2
    read -r selection
    if [[ "${selection}" =~ ^[0-9]+$ ]] && (( selection >= 1 && selection <= ${#configs[@]} )); then
      printf "%s\n" "${configs[$((selection - 1))]}"
      return 0
    fi
    echo "Invalid selection." >&2
  done
}

resolve_config_path() {
  local requested="${1:-}"

  if [[ -n "${requested}" ]]; then
    if [[ -f "${requested}" ]]; then
      printf "%s\n" "$(cd "$(dirname "${requested}")" && pwd)/$(basename "${requested}")"
      return 0
    fi
    if [[ -f "${CONFIGS_DIR}/${requested}" ]]; then
      printf "%s\n" "${CONFIGS_DIR}/${requested}"
      return 0
    fi
    if [[ -f "${CONFIGS_DIR}/${requested}.env" ]]; then
      printf "%s\n" "${CONFIGS_DIR}/${requested}.env"
      return 0
    fi
    echo "Config not found: ${requested}" >&2
    return 1
  fi

  if [[ -d "${CONFIGS_DIR}" ]]; then
    local config_count
    config_count="$(find "${CONFIGS_DIR}" -maxdepth 1 -type f -name "*.env" | wc -l | tr -d ' ')"
    if [[ "${config_count}" -gt 0 ]]; then
      select_config_interactively
      return 0
    fi
  fi

  echo "No config files found in ${CONFIGS_DIR}. Add at least one *.env file there." >&2
  return 1
}

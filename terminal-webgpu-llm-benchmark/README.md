# Terminal WebGPU LLM Benchmark

An interactive terminal-based benchmark suite for LLM models running on Terminal WebGPU, featuring agentic AI loops with real-time progress visualization and comprehensive logging.

## Features

- 🎯 **Interactive CLI** - Rich terminal UI with menus, progress bars, and formatted output
- 🤖 **Agentic AI Loops** - Multi-step reasoning with tool use and validation
- 📊 **Benchmark Suite** - Pre-configured benchmark cases with validation
- 📝 **Flexible Logging** - Optional file logging with automatic timestamps
- 🔍 **Three Output Modes**:
  - **Summary** (default) - Clean, step-by-step progress display
  - **Verbose** (`--verbose`) - Full API request/response debug output
  - **Silent** (`--silent`) - Minimal output, errors only

## Installation

```bash
pnpm install
```

## Usage

### Interactive Mode (Default)

Start the interactive menu:

```bash
pnpm start
```

This launches a menu where you can:
1. Run a benchmark (with case selection or custom prompt)
2. List available benchmark cases
3. Select a model to use
4. Exit

When running a benchmark interactively, you'll be prompted to configure output:
- **Show verbose debug output?** - Choose between summary and full verbose mode
- **Save debug log to file?** - Optionally save debug output to a file (default: `benchmark-YYYY-MM-DDTHH-mm-ss.log`, e.g., `benchmark-2026-04-02T13-13-07.log`)

### Quick Setup Mode

Run with options directly:

```bash
# Run with default options (summary mode)
pnpm run benchmark

# With verbose output
pnpm start -- --verbose

# With file logging
pnpm start -- --log-file debug.log

# All together
pnpm start -- --verbose --log-file debug.log
```

### CLI Mode

Run non-interactively with a prompt:

```bash
# Simple prompt
pnpm start -- "What is 2 + 2?"

# With model selection
pnpm start -- --model "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC" "Your prompt here"

# With benchmark case
pnpm start -- --case hello "Task prompt"

# Multiple runs
pnpm start -- --runs 5 "Your prompt"

# With all options
pnpm start -- --verbose --log-file results.log --runs 3 "Your prompt"
```

### List Available Cases

```bash
pnpm start -- --list-cases
```

## Command-Line Options

| Option | Short | Description | Example |
|--------|-------|-------------|---------|
| `--model` | - | Model ID to use | `--model "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC"` |
| `--runs` | - | Number of benchmark runs | `--runs 5` |
| `--case` | - | Benchmark case ID | `--case hello` |
| `--list-cases` | - | Show available cases | `--list-cases` |
| `--verbose` | `-v` | Show full debug output | `--verbose` |
| `--silent` | `-s` | Suppress debug output | `--silent` |
| `--log-file` | - | Save debug log to file | `--log-file debug.log` |
| `--no-interactive` | - | Skip menu, use setup wizard | `--no-interactive` |

## Output Modes

### Summary Mode (Default)

Shows step-by-step progress without verbose details:

```
Step 1: 🤔 generating
  → Tool: list_models
Step 2: 🤔 generating
  → Tool: current_time
Step 3: 🤔 generating

▶ Final Answer
model_count: 47
time_observed: Thu Apr  2 13:13:07 CEST 2026
```

### Verbose Mode (`--verbose`)

Full API request/response logging:

```
-> /v1/chat/completions
{"model":"...","messages":[...]}

<- /v1/chat/completions
{"id":"...","choices":[...]}

Step 1: tool list_models
...
```

### Silent Mode (`--silent`)

Only output final results and errors.

## Logging

### File Logging

Enable file logging with `--log-file`:

```bash
pnpm start -- --log-file debug.log
```

**Features:**
- Automatic timestamp added to filename: `debug-2026-04-02T13-13-07.log`
- All ANSI color codes removed for clean text files
- Session header with start time
- Timestamped entries for all operations
- Test results appended at the end of each run (final answer, summary, validation, metrics)
- Benchmark summary appended at the end of all runs (aggregate stats)

**Example log entry:**
```
================================================================================
Session started at 2026-04-02T11:12:44.187Z
================================================================================
[2026-04-02T11:12:44.189Z] -> /health
[2026-04-02T11:12:44.244Z] <- /health
[2026-04-02T11:12:50.312Z] step 1: generating
[2026-04-02T11:12:50.312Z] INFO: → Tool: list_models

▶ Final Answer
────────────────────────────────────────────────────────────────────────────────
model_count: 47 and time_observed: Wed Apr 2 11:12:55 CEST 2026

▶ Summary
────────────────────────────────────────────────────────────────────────────────
Retrieved the available models and current local time

Validation Results
✓ Overall: PASSED

  ✓ used_list_models
     tool used at step 1
  ✓ used_current_time
     tool used at step 2
  ✓ reported_model_count
     expected count 47
  ✓ reported_time_value
     correct time format

Run Metrics
  Steps: 3.00
  Time: 12162ms

════════════════════════════════════════════════════════════════════════════════
  Benchmark Summary
════════════════════════════════════════════════════════════════════════════════

Benchmark Results
  Total Runs: 1.00
  Avg Time: 12162ms
  Avg Steps: 3.00
  Min Time: 12162ms
  Max Time: 12162ms

ℹ Debug log saved to file: benchmark-2026-04-02T11-12-44.log
```

### Combining Modes

- `--verbose --log-file` - Full debug to both terminal and file
- `--silent --log-file` - Clean terminal, full details in file
- Default with `--log-file` - Summary to terminal, full debug in file (best practice)

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TERMINAL_WEBGPU_LLM_API_URL` | API endpoint | `http://127.0.0.1:5179` |
| `MODEL` | Default model | `Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC` |

## Benchmark Cases

Available pre-configured cases:

```bash
pnpm start -- --list-cases
```

Each case includes:
- Predefined prompt for consistent testing
- Validation rules to check answer correctness
- Expected outputs

## Examples

### Run a Single Benchmark

```bash
pnpm start -- "Count the models available"
```

### Run a Benchmark Case Multiple Times

```bash
pnpm start -- --case hello --runs 3
```

### Benchmark Different Models

```bash
pnpm start -- --model "Llama-3.2-1B-Instruct-q4f16_1-MLC" --runs 2 "Your task"
```

### Performance Testing with Full Logging

```bash
pnpm start -- --verbose --log-file perf-test.log --runs 5 "Complex reasoning task"
```

### Silent Mode for CI/Automation

```bash
pnpm start -- --silent --runs 1 "Task" > results.txt 2>&1
```

## Output Files

When using `--log-file`, timestamped logs are created:

```
debug-2026-04-02T13-13-07.log
debug-2026-04-02T13-14-22.log
debug-2026-04-02T13-15-45.log
```

Each log contains:
- Complete API request/response details
- Agent loop execution trace
- Tool call details and results
- Timestamps for all operations

## Architecture

### Components

- **TerminalUI** - Rich terminal formatting and interaction
- **UILogger** - Display logs to terminal
- **SummaryLogger** - Show only key steps (default)
- **FileLogger** - Write timestamped logs to file
- **CombinedLogger** - Log to multiple destinations
- **TerminalWebgpuApiClient** - API communication
- **runAgentLoop** - Agentic reasoning engine

### Modes

1. **Interactive Mode** - Full menu-driven experience
2. **Quick Setup Mode** - Guided setup without menu loop
3. **CLI Mode** - Direct execution with arguments

## Requirements

- Node.js 18+
- Terminal WebGPU LLM API running (default: `http://127.0.0.1:5179`)
- pnpm or npm

## Scripts

```bash
# Interactive mode (default)
pnpm start

# Quick setup mode
pnpm run benchmark

# Run both verbose and silent for comparison
pnpm start -- --verbose --log-file verbose.log "test task"
pnpm start -- --silent "test task"
```

## Troubleshooting

### API Connection Failed

Ensure the Terminal WebGPU LLM API is running:

```bash
# Set custom API URL if needed
export TERMINAL_WEBGPU_LLM_API_URL="http://localhost:5179"
pnpm start
```

### Model Loading

Select a model from the available list via the interactive menu or specify with `--model`.

### Log File Size

Verbose logging creates large files. Use `--silent --log-file` to log only important events.

## License

MIT

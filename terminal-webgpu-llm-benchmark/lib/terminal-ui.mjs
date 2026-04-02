import readline from "readline";
import { createWriteStream } from "fs";
import { resolve } from "path";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
};

export class TerminalUI {
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.colors = colors;
  }

  clear() {
    console.clear();
  }

  header(title) {
    const line = "═".repeat(this.width);
    console.log(`${colors.cyan}${line}${colors.reset}`);
    console.log(`${colors.cyan}${colors.bright}  ${title}${colors.reset}`);
    console.log(`${colors.cyan}${line}${colors.reset}`);
  }

  subheader(title) {
    console.log(`\n${colors.bright}${colors.blue}▶ ${title}${colors.reset}`);
    console.log(`${colors.blue}${"─".repeat(this.width - 4)}${colors.reset}`);
  }

  section(title) {
    console.log(`\n${colors.yellow}${colors.bright}${title}${colors.reset}`);
  }

  success(text) {
    console.log(`${colors.green}✓ ${text}${colors.reset}`);
  }

  error(text) {
    console.log(`${colors.red}✗ ${text}${colors.reset}`);
  }

  warning(text) {
    console.log(`${colors.yellow}⚠ ${text}${colors.reset}`);
  }

  info(text) {
    console.log(`${colors.cyan}ℹ ${text}${colors.reset}`);
  }

  status(label, value, color = colors.white) {
    console.log(`  ${colors.dim}${label}:${colors.reset} ${color}${value}${colors.reset}`);
  }

  step(num, total, text) {
    const progress = `[${num}/${total}]`;
    console.log(`${colors.blue}${progress}${colors.reset} ${text}`);
  }

  progressBar(current, total, width = 30) {
    const percent = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * width);
    const empty = width - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    return `${colors.green}${bar}${colors.reset} ${percent}%`;
  }

  metric(name, value, unit = "", color = colors.cyan) {
    const formattedValue =
      typeof value === "number" && unit === "ms"
        ? Math.round(value)
        : typeof value === "number"
          ? value.toFixed(2)
          : value;
    console.log(`  ${colors.dim}${name}:${colors.reset} ${color}${formattedValue}${unit}${colors.reset}`);
  }

  table(headers, rows) {
    const colWidths = headers.map((h) => Math.max(h.length, ...rows.map((r) => String(r[headers.indexOf(h)]).length)));

    const headerRow = headers
      .map((h, i) => h.padEnd(colWidths[i]))
      .join("  ");
    console.log(`${colors.bright}${colors.cyan}${headerRow}${colors.reset}`);
    console.log(colors.cyan + "─".repeat(headerRow.replace(/\x1b\[[0-9;]*m/g, "").length) + colors.reset);

    rows.forEach((row) => {
      const formattedRow = row
        .map((cell, i) => String(cell).padEnd(colWidths[i]))
        .join("  ");
      console.log(formattedRow);
    });
  }

  menu(title, options) {
    this.section(title);
    options.forEach((opt, i) => {
      console.log(`  ${colors.bright}${i + 1}${colors.reset}. ${opt}`);
    });
  }

  input(prompt) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(`${colors.bright}${prompt}${colors.reset} `, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  confirm(prompt) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(`${colors.bright}${prompt} (y/n)${colors.reset} `, (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y");
      });
    });
  }

  box(title, content) {
    const maxLine = Math.max(title.length, ...content.split("\n").map((l) => l.length)) + 4;
    const width = Math.min(maxLine, this.width - 4);
    const boxLine = "┌" + "─".repeat(width - 2) + "┐";

    console.log(`${colors.cyan}${boxLine}${colors.reset}`);
    console.log(
      `${colors.cyan}│${colors.reset} ${colors.bright}${title.padEnd(width - 4)}${colors.reset} ${colors.cyan}│${colors.reset}`
    );
    console.log(`${colors.cyan}├${"─".repeat(width - 2)}┤${colors.reset}`);

    content.split("\n").forEach((line) => {
      const paddedLine = line.padEnd(width - 4);
      console.log(`${colors.cyan}│${colors.reset} ${paddedLine} ${colors.cyan}│${colors.reset}`);
    });

    const boxBottom = "└" + "─".repeat(width - 2) + "┘";
    console.log(`${colors.cyan}${boxBottom}${colors.reset}`);
  }

  spinner(text) {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const interval = setInterval(() => {
      process.stdout.write(`\r${colors.cyan}${frames[frame]}${colors.reset} ${text}`);
      frame = (frame + 1) % frames.length;
    }, 80);

    return {
      stop: (finalText) => {
        clearInterval(interval);
        process.stdout.write(`\r${colors.green}✓${colors.reset} ${finalText}\n`);
      },
    };
  }

  agentStep(stepNum, action, details = "") {
    const icon = action === "generating" ? "🤔" : action === "tool" ? "🔧" : "📝";
    console.log(`${colors.bright}${colors.blue}Step ${stepNum}: ${icon} ${action}${colors.reset}`);
    if (details) {
      console.log(`${colors.dim}${details}${colors.reset}`);
    }
  }

  agentThinking(stepNum) {
    this.agentStep(stepNum, "generating", "Generating response...");
  }

  agentTool(stepNum, toolName, input) {
    const inputStr = JSON.stringify(input).slice(0, 60);
    this.agentStep(stepNum, "tool", `Calling ${colors.yellow}${toolName}${colors.reset} with ${inputStr}`);
  }

  agentResult(stepNum, result) {
    const resultStr = JSON.stringify(result).slice(0, 100);
    console.log(`${colors.green}✓ Result: ${colors.dim}${resultStr}${colors.reset}`);
  }

  agentFinal(answer, reasoning) {
    this.subheader("Final Answer");
    console.log(`${colors.white}${answer}${colors.reset}`);
    if (reasoning) {
      this.subheader("Summary");
      console.log(`${colors.dim}${reasoning}${colors.reset}`);
    }
  }

  benchmark(results) {
    this.section("Benchmark Results");
    const runs = results.runs;
    const avgMs = results.avgMs;
    const avgSteps = results.avgSteps;
    const minMs = results.minMs;
    const maxMs = results.maxMs;

    this.metric("Total Runs", runs);
    this.metric("Avg Time", avgMs, "ms", colors.green);
    this.metric("Avg Steps", avgSteps);
    this.metric("Min Time", minMs, "ms", colors.cyan);
    this.metric("Max Time", maxMs, "ms", colors.yellow);
  }

  validation(validation) {
    this.section("Validation Results");
    const passed = validation?.checks?.every((c) => c.passed);
    const icon = passed ? colors.green + "✓" : colors.red + "✗";

    console.log(`${icon}${colors.reset} Overall: ${passed ? "PASSED" : "FAILED"}\n`);

    validation?.checks?.forEach((check) => {
      const checkIcon = check.passed ? colors.green + "✓" : colors.red + "✗";
      console.log(`  ${checkIcon}${colors.reset} ${colors.dim}${check.name}${colors.reset}`);
      if (check.details) {
        console.log(`     ${colors.dim}${check.details}${colors.reset}`);
      }
    });
  }

  footer(text) {
    console.log(`\n${colors.dim}${"─".repeat(this.width)}${colors.reset}`);
    console.log(`${colors.dim}${text}${colors.reset}`);
  }

  blank() {
    console.log();
  }
}

export class UILogger {
  constructor(ui) {
    this.ui = ui;
  }

  log(message) {
    console.log(message);
  }

  error(message) {
    this.ui.error(message);
  }

  warn(message) {
    this.ui.warning(message);
  }

  info(message) {
    this.ui.info(message);
  }
}

export class SummaryLogger {
  constructor(ui) {
    this.ui = ui;
    this.currentStep = 0;
  }

  log(message) {
    const msg = String(message);
    
    // Track step transitions
    if (msg.includes("step ") && msg.includes(": generating")) {
      this.currentStep = parseInt(msg.match(/step (\d+)/)?.[1] || "0");
      this.ui.agentThinking(this.currentStep);
    }
    
    // Show tool calls
    if (msg.includes("step ") && msg.includes(": tool ")) {
      const toolMatch = msg.match(/tool (\w+)/);
      if (toolMatch) {
        this.ui.info(`  → Tool: ${this.ui.colors.yellow}${toolMatch[1]}${this.ui.colors.reset}`);
      }
    }
    
    // Show final result
    if (msg.includes("raw model reply")) {
      // Skip verbose JSON output
      return;
    }
    
    if (msg.startsWith('{"type"') || msg.startsWith('->') || msg.startsWith('<-')) {
      // Skip JSON and API request details
      return;
    }
  }

  error(message) {
    this.ui.error(message);
  }

  warn(message) {
    this.ui.warning(message);
  }

  info(message) {
    this.ui.info(message);
  }
}

export class SilentLogger {
  log() {}
  error() {}
  warn() {}
  info() {}
}

export class FileLogger {
  constructor(filePath) {
    // Add timestamp to filename
    const path = resolve(filePath);
    const lastDot = path.lastIndexOf('.');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5); // e.g., 2026-04-02T12-30-45
    
    const finalPath = lastDot > 0 
      ? path.slice(0, lastDot) + `-${timestamp}` + path.slice(lastDot)
      : path + `-${timestamp}`;
    
    this.filePath = finalPath;
    this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf-8' });
    this.stream.write(`\n${"=".repeat(80)}\nSession started at ${new Date().toISOString()}\n${"=".repeat(80)}\n`);
  }

  write(message) {
    const timestamp = new Date().toISOString();
    const text = String(message).replace(/\x1b\[[0-9;]*m/g, ''); // Remove ANSI color codes
    this.stream.write(`[${timestamp}] ${text}\n`);
  }

  log(message) {
    this.write(message);
  }

  error(message) {
    this.write(`ERROR: ${message}`);
  }

  warn(message) {
    this.write(`WARN: ${message}`);
  }

  info(message) {
    this.write(`INFO: ${message}`);
  }

  close() {
    return new Promise((resolve) => {
      this.stream.end(() => {
        resolve();
      });
    });
  }

  appendResults(result) {
    return new Promise((resolve) => {
      this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf-8' });
      const separator = '─'.repeat(80);
      
      // Final Answer section
      if (result.answer) {
        this.stream.write(`\n▶ Final Answer\n${separator}\n`);
        this.stream.write(`${result.answer}\n`);
      }
      
      // Summary section
      if (result.reasoning) {
        this.stream.write(`\n▶ Summary\n${separator}\n`);
        this.stream.write(`${result.reasoning}\n`);
      }
      
      // Validation section
      if (result.validation) {
        this.stream.write(`\nValidation Results\n`);
        const passed = result.validation?.checks?.every((c) => c.passed);
        const icon = passed ? '✓' : '✗';
        this.stream.write(`${icon} Overall: ${passed ? 'PASSED' : 'FAILED'}\n\n`);
        
        result.validation?.checks?.forEach((check) => {
          const checkIcon = check.passed ? '✓' : '✗';
          this.stream.write(`  ${checkIcon} ${check.name}\n`);
          if (check.details) {
            this.stream.write(`     ${check.details}\n`);
          }
        });
      }
      
      // Metrics section
      this.stream.write(`\n\nRun Metrics\n`);
      this.stream.write(`  Steps: ${(result.step).toFixed(2)}\n`);
      this.stream.write(`  Time: ${result.elapsedMs}ms\n`);
      
      this.stream.end(() => {
        resolve();
      });
    });
  }

  appendBenchmarkSummary(summary, actualLogFile) {
    return new Promise((resolve) => {
      this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf-8' });
      const separator = '═'.repeat(80);
      
      this.stream.write(`\n${separator}\n`);
      this.stream.write(`  Benchmark Summary\n`);
      this.stream.write(`${separator}\n\n`);
      
      this.stream.write(`Benchmark Results\n`);
      this.stream.write(`  Total Runs: ${(summary.runs).toFixed(2)}\n`);
      this.stream.write(`  Avg Time: ${summary.avgMs}ms\n`);
      this.stream.write(`  Avg Steps: ${(summary.avgSteps).toFixed(2)}\n`);
      this.stream.write(`  Min Time: ${summary.minMs}ms\n`);
      this.stream.write(`  Max Time: ${summary.maxMs}ms\n`);
      
      if (actualLogFile) {
        this.stream.write(`\nℹ Debug log saved to file: ${actualLogFile}\n`);
      }
      
      this.stream.end(() => {
        resolve();
      });
    });
  }
}

export class CombinedLogger {
  constructor(primary, secondary) {
    this.primary = primary;
    this.secondary = secondary;
  }

  log(message) {
    this.primary.log?.(message);
    this.secondary.log?.(message);
  }

  error(message) {
    this.primary.error?.(message);
    this.secondary.error?.(message);
  }

  warn(message) {
    this.primary.warn?.(message);
    this.secondary.warn?.(message);
  }

  info(message) {
    this.primary.info?.(message);
    this.secondary.info?.(message);
  }

  getSecondary() {
    return this.secondary;
  }

  close() {
    const promises = [];
    if (this.primary.close) promises.push(this.primary.close());
    if (this.secondary.close) promises.push(this.secondary.close());
    return Promise.all(promises);
  }
}

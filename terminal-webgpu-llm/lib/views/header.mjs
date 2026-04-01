export function createHeader(blessed, screen) {
  return blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { fg: "black", bg: "green" },
    content: " {bold}Terminal WebGPU LLM TUI{/bold}  q quit  Ctrl+L load  /model <id> switch  /models list",
  });
}

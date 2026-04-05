export function createPrompt(blessed, screen) {
  return blessed.textarea({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    label: " Prompt (Enter send, Ctrl+S newline) ",
    inputOnFocus: true,
    keys: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "magenta" } },
  });
}

export function createPrompt(blessed, screen) {
  return blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 4,
    border: "line",
    label: " Prompt ",
    inputOnFocus: true,
    keys: true,
    mouse: true,
    style: { border: { fg: "magenta" } },
  });
}

export function createPerformance(blessed, screen) {
  return blessed.box({
    parent: screen,
    bottom: 4,
    right: 0,
    width: "28%",
    height: 8,
    border: "line",
    label: " Performance ",
    content: "",
    keys: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "green" } },
  });
}

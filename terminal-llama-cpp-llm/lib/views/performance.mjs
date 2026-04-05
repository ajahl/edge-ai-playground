export function createPerformance(blessed, screen) {
  return blessed.box({
    parent: screen,
    top: "50%+3",
    left: "72%",
    width: "28%",
    height: "50%-5",
    border: "line",
    label: " Performance ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "magenta" } },
  });
}

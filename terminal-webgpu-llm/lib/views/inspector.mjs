export function createInspector(blessed, screen) {
  return blessed.box({
    parent: screen,
    top: 4,
    right: 0,
    width: "28%",
    height: "100%-16",
    border: "line",
    label: " Inspector ",
    content: "",
    keys: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "yellow" } },
  });
}
